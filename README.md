# Google Drive Merge Sync

[![Downloads](https://img.shields.io/github/downloads/kebl3541/Obsidian-Google-Drive-Merge-Sync/total?style=flat&logo=github&label=Downloads&color=success&cacheSeconds=3600)](https://github.com/kebl3541/Obsidian-Google-Drive-Merge-Sync/releases)
[![GitHub stars](https://img.shields.io/github/stars/kebl3541/Obsidian-Google-Drive-Merge-Sync?style=flat&logo=github&label=Stars&cacheSeconds=5400)](https://github.com/kebl3541/Obsidian-Google-Drive-Merge-Sync/stargazers)
[![Latest release](https://img.shields.io/github/v/release/kebl3541/Obsidian-Google-Drive-Merge-Sync?style=flat&label=Release&cacheSeconds=3600)](https://github.com/kebl3541/Obsidian-Google-Drive-Merge-Sync/releases/latest)

Sync your vault with Google Drive, using your own Google credentials. When the
same note changed on two devices, most sync tools give you a conflicted copy
or silently pick a winner. This one merges the two versions word by word, and
only where both sides changed the same words does it keep yours and say so.

<p align="center">If this plugin adds value for you and you would like to help support
continued development, please use the buttons below:</p>

<p align="center">
<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>
</p>

<p align="center"><strong><a href="https://buymeacoffee.com/philosophizer">☕ Buy me a coffee</a></strong>&nbsp;&nbsp;·&nbsp;&nbsp;<strong><a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR">💙 Donate via PayPal</a></strong></p>

<p align="center">If you like this plugin or find it useful, please consider giving it a <a href="https://github.com/kebl3541/Obsidian-Google-Drive-Merge-Sync">star</a> <a href="https://github.com/kebl3541/Obsidian-Google-Drive-Merge-Sync"><img src="https://img.shields.io/github/stars/kebl3541/Obsidian-Google-Drive-Merge-Sync?style=social" alt="GitHub Repo stars"></a> on GitHub!</p>


## Why it is different

- **Conflicts are merged, not duplicated.** Text files resolve by word level
  three way merge against the last synced version. The merge engine is shared
  with the AI Co-Editor plugin and covered by its test suite.
- **Nothing is ever destroyed.** Deletes travel to Obsidian's trash locally
  and to the Drive trash remotely. Both are reversible.
- **Your credentials, your Drive.** You create a free Google OAuth client;
  tokens live on your machine; the plugin can only see the one folder it
  creates, thanks to the narrow drive.file permission.
- **Dry run first.** A command shows exactly what a sync would do before it
  does anything.

## Setup, once, about five minutes

1. Go to console.cloud.google.com and create a project (any name).
2. APIs and Services, Library: enable the Google Drive API.
3. APIs and Services, OAuth consent screen: External, fill the two required
   fields, add yourself as a test user.
4. APIs and Services, Credentials: Create credentials, OAuth client ID, type
   Desktop app. Copy the client ID and client secret.
5. In Obsidian, open the plugin settings, paste both values, press Connect
   Google Drive, and approve in the browser.

## Use

- Click the sync icon in the ribbon, or run the command "Sync now".
- Optionally set an interval in settings for automatic syncing.
- "Preview what a sync would do" shows the plan without touching anything.
- On a second device, install the plugin, connect with the same Google
  account, set the same folder name, and sync.

## Mobile

Sign in once on a desktop, then in settings copy the connection code and paste
it into the same setting on your phone or tablet. The device syncs from then
on without any browser dance. Treat the code like a password.

## Renames

Renames sync as renames on both sides: links keep pointing at the note, and
Drive keeps the file's history. When two renamed files are indistinguishable,
the plugin falls back to the safe delete plus create rather than guess.

## Honest limits

- Very large vaults sync fine but the first pass uploads everything.

## Security and privacy

Points Obsidian's automated plugin review flags, and what they mean here:

- **Vault enumeration**: a sync plugin has one job — compare every local file with its remote counterpart — so it necessarily lists the vault's files each sync. Folders you exclude in settings are skipped. File contents are read only to upload, download, or merge them.
- **Clipboard**: written to exactly once, when you click "Copy connection code" to move your connection to another device. The plugin never reads the clipboard.
- **Where your data goes**: only to Google Drive, over your own OAuth client with the narrow `drive.file` scope, meaning the plugin can only ever see the folder it created — nothing else in your Drive. Tokens stay on your machine; no third-party server is involved, ever.

## Support

If this plugin adds value for you and you would like to help support continued
development, please use the buttons below:

<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>

## License

MIT
