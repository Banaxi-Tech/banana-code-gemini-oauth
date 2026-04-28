import chalk from 'chalk';

import { clearTokens, runAuthFlow } from './auth.js';
import { GeminiOAuthProvider } from './provider.js';

export default async function plugin(api) {
    api.registerProvider('gemini-oauth', 'Gemini (OAuth)', GeminiOAuthProvider);

    api.registerCommand('/gemini-oauth-login', 'Authenticate Gemini OAuth for Banana Code', async () => {
        await runAuthFlow();
        console.log(chalk.green('Gemini OAuth login complete.'));
    });

    api.registerCommand('/gemini-oauth-logout', 'Clear stored Gemini OAuth tokens', async () => {
        await clearTokens();
        console.log(chalk.green('Gemini OAuth tokens cleared.'));
    });
}
