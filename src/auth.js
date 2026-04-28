import { input } from '@inquirer/prompts';
import { generatePKCE } from '@openauthjs/openauth/pkce';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_CLIENT_SECRET = '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';
const GEMINI_SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
];
const GEMINI_REDIRECT_URI = 'http://localhost:8085/oauth2callback';
const TOKEN_FILE = path.join(os.homedir(), '.config', 'banana-code', 'gemini-oauth-token.json');
const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

let authFlowPromise = null;
let refreshPromise = null;

function accessTokenExpired(auth) {
    if (!auth?.access || typeof auth.expires !== 'number') {
        return true;
    }

    return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

async function ensureTokenDirectory() {
    await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
}

async function readStoredTokens() {
    try {
        const raw = await fs.readFile(TOKEN_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

async function writeStoredTokens(record) {
    await ensureTokenDirectory();
    await fs.writeFile(TOKEN_FILE, JSON.stringify(record, null, 2), 'utf8');
}

export async function saveAuthRecord(record) {
    await writeStoredTokens(record);
}

async function authorizeGemini() {
    const pkce = await generatePKCE();
    const state = randomBytes(32).toString('hex');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');

    url.searchParams.set('client_id', GEMINI_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', GEMINI_REDIRECT_URI);
    url.searchParams.set('scope', GEMINI_SCOPES.join(' '));
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.hash = 'banana-code';

    return {
        url: url.toString(),
        verifier: pkce.verifier,
        state
    };
}

async function exchangeGeminiWithVerifier(code, verifier) {
    try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: GEMINI_CLIENT_ID,
                client_secret: GEMINI_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: GEMINI_REDIRECT_URI,
                code_verifier: verifier
            })
        });

        if (!tokenResponse.ok) {
            return {
                type: 'failed',
                error: await tokenResponse.text()
            };
        }

        const tokenPayload = await tokenResponse.json();
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
            headers: {
                Authorization: `Bearer ${tokenPayload.access_token}`
            }
        });
        const userInfo = userInfoResponse.ok ? await userInfoResponse.json() : {};

        if (!tokenPayload.refresh_token) {
            return {
                type: 'failed',
                error: 'Missing refresh token in response'
            };
        }

        return {
            type: 'success',
            refresh: tokenPayload.refresh_token,
            access: tokenPayload.access_token,
            expires: Date.now() + tokenPayload.expires_in * 1000,
            email: userInfo.email
        };
    } catch (error) {
        return {
            type: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

async function refreshAccessToken(record) {
    if (refreshPromise) {
        return refreshPromise;
    }

    refreshPromise = (async () => {
        if (!record?.refresh) {
            return null;
        }

        try {
            const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: record.refresh,
                    client_id: GEMINI_CLIENT_ID,
                    client_secret: GEMINI_CLIENT_SECRET
                })
            });

            if (!response.ok) {
                let errorText = '';
                try {
                    errorText = await response.text();
                } catch {
                    errorText = '';
                }

                if (/invalid_grant/i.test(errorText)) {
                    await clearTokens();
                }

                return null;
            }

            const payload = await response.json();
            const updated = {
                ...record,
                access: payload.access_token,
                expires: Date.now() + payload.expires_in * 1000,
                refresh: payload.refresh_token || record.refresh
            };

            await writeStoredTokens(updated);
            return updated;
        } catch {
            return null;
        }
    })();

    try {
        return await refreshPromise;
    } finally {
        refreshPromise = null;
    }
}

function parseOAuthCallbackInput(rawInput) {
    const trimmed = rawInput.trim();
    if (!trimmed) {
        return {};
    }

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            return {
                code: url.searchParams.get('code') || undefined,
                state: url.searchParams.get('state') || undefined
            };
        } catch {
            return {};
        }
    }

    const candidate = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
    if (candidate.includes('=')) {
        const params = new URLSearchParams(candidate);
        const code = params.get('code') || undefined;
        const state = params.get('state') || undefined;
        if (code || state) {
            return { code, state };
        }
    }

    return { code: trimmed };
}

function shouldIgnoreMalformedAuthCode(result) {
    return result?.type === 'failed'
        && /invalid_grant/i.test(result.error)
        && /malformed auth code/i.test(result.error);
}

async function persistAuthResult(result) {
    if (result.type !== 'success') {
        throw new Error(result.error || 'Gemini OAuth authentication failed');
    }

    const stored = {
        type: 'oauth',
        refresh: result.refresh,
        access: result.access,
        expires: result.expires,
        email: result.email
    };

    await writeStoredTokens(stored);

    if (result.email) {
        console.log(chalk.green(`Authenticated Gemini OAuth as ${result.email}.`));
    } else {
        console.log(chalk.green('Authenticated Gemini OAuth.'));
    }

    return stored.access;
}

function openBrowserUrl(url) {
    try {
        const platform = process.platform;
        const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open';
        const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
        const child = spawn(command, args, {
            stdio: 'ignore',
            detached: true
        });
        child.unref?.();
    } catch {}
}

async function startOAuthListener({ timeoutMs = 5 * 60 * 1000 } = {}) {
    const redirectUri = new URL(GEMINI_REDIRECT_URI);
    const callbackPath = redirectUri.pathname || '/';
    const port = redirectUri.port ? Number.parseInt(redirectUri.port, 10) : 80;
    const origin = `${redirectUri.protocol}//${redirectUri.host}`;
    const queue = [];
    const waiters = [];
    let terminalError;

    const deliver = (url) => {
        const waiter = waiters.shift();
        if (waiter) {
            waiter.resolve(url);
            return;
        }
        queue.push(url);
    };

    const failWaiters = (error) => {
        if (terminalError) {
            return;
        }

        terminalError = error;
        while (waiters.length > 0) {
            waiters.shift()?.reject(error);
        }
    };

    const successResponse = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Banana Code Gemini OAuth</title>
</head>
<body style="font-family: sans-serif; display: flex; min-height: 100vh; align-items: center; justify-content: center;">
  <main style="max-width: 32rem; text-align: center;">
    <h1>Gemini connected to Banana Code</h1>
    <p>You can close this window and continue in the CLI.</p>
  </main>
</body>
</html>`;

    const timeoutHandle = setTimeout(() => {
        failWaiters(new Error('Timed out waiting for OAuth callback'));
    }, timeoutMs);
    timeoutHandle.unref?.();

    const server = createServer((request, response) => {
        if (!request.url) {
            response.writeHead(400, { 'Content-Type': 'text/plain' });
            response.end('Invalid request');
            return;
        }

        const url = new URL(request.url, origin);
        if (url.pathname !== callbackPath) {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('Not found');
            return;
        }

        const hasCode = !!url.searchParams.get('code');
        const hasState = !!url.searchParams.get('state');
        const hasError = !!url.searchParams.get('error');
        if (!hasError && (!hasCode || !hasState)) {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Ignoring incomplete OAuth callback. Return to the Google sign-in flow.');
            return;
        }

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(successResponse);
        deliver(url);
    });

    await new Promise((resolve, reject) => {
        const handleError = (error) => {
            server.off('error', handleError);
            reject(error);
        };

        server.once('error', handleError);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', handleError);
            resolve();
        });
    });

    server.on('error', (error) => {
        failWaiters(error instanceof Error ? error : new Error(String(error)));
    });

    return {
        async waitForCallback() {
            if (queue.length > 0) {
                return queue.shift();
            }

            if (terminalError) {
                throw terminalError;
            }

            return await new Promise((resolve, reject) => {
                waiters.push({ resolve, reject });
            });
        },
        async close() {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
                        reject(error);
                        return;
                    }

                    clearTimeout(timeoutHandle);
                    failWaiters(new Error('OAuth listener closed before callback'));
                    resolve();
                });
            });
        }
    };
}

async function runAuthFlowInternal() {
    const isHeadless = !!(
        process.env.SSH_CONNECTION
        || process.env.SSH_CLIENT
        || process.env.SSH_TTY
        || process.env.BANANA_CODE_HEADLESS
    );

    let listener = null;
    if (!isHeadless) {
        try {
            listener = await startOAuthListener();
        } catch (error) {
            const detail = error instanceof Error ? ` (${error.message})` : '';
            console.log(`Warning: Couldn't start the local callback listener${detail}. You'll need to paste the callback URL or authorization code.`);
        }
    } else {
        console.log('Headless environment detected. You will need to paste the callback URL or authorization code.');
    }

    const authorization = await authorizeGemini();
    console.log(chalk.cyan('Open the following URL to authenticate with Google:'));
    console.log(chalk.gray(authorization.url));

    if (!isHeadless) {
        openBrowserUrl(authorization.url);
    }

    if (listener) {
        try {
            while (true) {
                const callbackUrl = await listener.waitForCallback();
                const callbackError = callbackUrl.searchParams.get('error');
                const callbackErrorDescription = callbackUrl.searchParams.get('error_description');
                if (callbackError) {
                    throw new Error(callbackErrorDescription || callbackError);
                }

                const code = callbackUrl.searchParams.get('code');
                const state = callbackUrl.searchParams.get('state');
                if (!code || !state) {
                    continue;
                }

                if (state !== authorization.state) {
                    continue;
                }

                const result = await exchangeGeminiWithVerifier(code, authorization.verifier);
                if (shouldIgnoreMalformedAuthCode(result)) {
                    continue;
                }

                return await persistAuthResult(result);
            }
        } finally {
            await listener.close().catch(() => {});
        }
    }

    const callbackInput = await input({
        message: 'Paste the redirected URL or authorization code:'
    });
    const { code, state } = parseOAuthCallbackInput(callbackInput);
    if (!code) {
        throw new Error('Missing authorization code in callback input');
    }

    if (state && state !== authorization.state) {
        throw new Error('State mismatch in callback input (possible CSRF attempt)');
    }

    return await persistAuthResult(
        await exchangeGeminiWithVerifier(code, authorization.verifier)
    );
}

export async function runAuthFlow() {
    if (authFlowPromise) {
        return authFlowPromise;
    }

    authFlowPromise = runAuthFlowInternal();

    try {
        return await authFlowPromise;
    } finally {
        authFlowPromise = null;
    }
}

export async function getValidToken() {
    const auth = await getAuthRecord();
    return auth.access;
}

export async function getAuthRecord() {
    const stored = await readStoredTokens();

    if (!stored?.refresh) {
        await runAuthFlow();
        const created = await readStoredTokens();
        if (!created?.access) {
            throw new Error('Gemini OAuth authentication did not produce a usable access token.');
        }
        return created;
    }

    if (!accessTokenExpired(stored)) {
        return stored;
    }

    const refreshed = await refreshAccessToken(stored);
    if (refreshed?.access && !accessTokenExpired(refreshed)) {
        return refreshed;
    }

    await runAuthFlow();
    const created = await readStoredTokens();
    if (!created?.access) {
        throw new Error('Gemini OAuth authentication did not produce a usable access token.');
    }
    return created;
}

export async function clearTokens() {
    await fs.rm(TOKEN_FILE, { force: true });
}
