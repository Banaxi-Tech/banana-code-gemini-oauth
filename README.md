# 🍌 Banana Gemini OAuth Plugin

[![NPM Version](https://img.shields.io/npm/v/banana-code-gemini-oauth?color=yellow&style=flat-square)](https://www.npmjs.com/package/banana-code-gemini-oauth)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Banana Code](https://img.shields.io/badge/Powered%20By-Banana%20Code-brightgreen?style=flat-square)](https://github.com/Banaxi-Tech/Banana-Code)

> [!CAUTION]
> **Use at your own risk.** Google’s policies indicate that utilizing Gemini CLI OAuth credentials within third-party tools (like this plugin) may be classified as a policy violation. This could potentially lead to account flags, abuse detection, or temporary restrictions. While enforcement varies, you should be aware of the inherent risks. If you prefer an officially supported and zero-risk method, we strongly recommend using Banana Code with a standard Google Cloud API Key instead.
>
> See: [google-gemini/gemini-cli#22970](https://github.com/google-gemini/gemini-cli/issues/22970)

A premium, secure OAuth 2.0 authentication provider for **Banana Code**, allowing you to use Google Gemini with your personal or workspace account without the hassle of managing API keys.

---

## ✨ Features

- **Seamless Authentication**: One-click Google Login flow via your browser.
- **Auto-Refresh**: Automatically handles token expiration and refreshing in the background.
- **Secure Storage**: Tokens are stored safely in your local config, never transmitted to third parties.
- **Multi-Model Support**: Access the latest 2.5 and 3.0 models directly.
- **Intelligent Tier Detection**: Built-in support for identifying Paid vs. Free account quotas.

---

## 🚀 Quick Start

### Installation

Install directly via the Banana Code CLI:

```bash
banana /plugin install banana-code-gemini-oauth
```

Alternatively, if you are developing locally:

```bash
banana /plugin install /path/to/banana-code-gemini-auth
```

### First Login

Once installed, simply select `Gemini (OAuth)` as your provider in Banana Code. On your first request, a browser window will open automatically for authentication.

For headless environments (SSH/Terminals), the plugin will provide a URL for manual authorization.

---

## 🛠 Commands

The plugin adds several useful commands to your Banana Code environment:

| Command | Description |
| :--- | :--- |
| `/gemini-oauth-login` | Re-trigger the Google OAuth flow to switch accounts or refresh access. |
| `/gemini-oauth-logout` | Securely wipe all stored OAuth tokens from your local machine. |

---

## 🧠 Supported Models

The plugin fully supports the Gemini model ecosystem:

- ⚡ **Gemini 3 Flash** (Fast & Efficient)
- 🚀 **Gemini 3.1 Pro** (Complex Reasoning)
- 🧪 **Experimental Models** (Latest from Google DeepMind)
- 🤖 **Auto Selection** (Optimized for your task)

---

## 🔐 Privacy & Security

We take your security seriously:
1. **Local Only**: Your OAuth tokens are stored at `~/.config/banana-code/gemini-oauth-token.json`.
2. **Direct to Google**: Authentication happens directly with Google; this plugin never sees your password.
3. **Minimal Scopes**: We only request the minimum permissions required to interact with the Gemini API.

---

## ⚡ Technical Details (For Developers)

### Token Management
Uses `@openauthjs/openauth` for robust PKCE-based OAuth 2.0 flows, ensuring compatibility with modern security standards.

---

## 🤝 Contributing

Contributions are welcome! If you find a bug or have a feature request, please open an issue or submit a pull request.

1. Fork the repository.
2. Create your feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add some amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

---

## 📄 License & Acknowledgments

This project is licensed under the **MIT License**.

Parts of the core logic and API integration patterns were adapted from the [opencode-gemini-auth](https://www.npmjs.com/package/opencode-gemini-auth) project by **Jens**. We are grateful for their work in the open-source community.

See the [LICENSE](LICENSE) file for the full license text and copyright notices.

---

<p align="center">
  Made with ❤️ by Banaxi for the Banana Code Community
</p>
