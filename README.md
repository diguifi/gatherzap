# gatherzap

Track WhatsApp groups and stack papers in Gather when they have unread messages.

On Windows, run **gatherzap.exe** to start the app in the system tray (the icons beside the clock, sometimes under the **^** arrow). Right-click its icon:

- **Open UI** opens the dashboard in your browser. Double-clicking the tray icon also opens it.
- **Shut down** stops gatherzap and its background processes, then removes the tray icon.

Closing the browser tab leaves gatherzap running. Launching the executable again while it is running opens the existing dashboard.

To build the executable on 64-bit Windows with Node.js 24+ and the .NET 10 SDK:

```sh
npm install
node scripts/build-windows.mjs
```

The executable is written to `dist/gatherzap.exe`.

1. Create an **Inbox Smart Object** in Gather and copy its **webhook URL** and **secret**.
2. Install and run gatherzap:

   ```sh
   npm i
   npm run ui
   ```

3. Open **http://127.0.0.1:3210** and scan the WhatsApp QR code.
4. Paste your Gather object's webhook URL and secret, then click **Save and continue**.
5. Choose the groups to track. Keep the app running to update your paper stack.

Click **Stop gatherzap** to shut down the app. The page will grey out and display “Run the executable to restart”. Launch the executable again to restart, or run `npm run ui` if you use npm.
