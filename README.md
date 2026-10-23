# gatherzap

Track WhatsApp groups and stack papers in Gather when they have unread messages.

1. Create an **Inbox Smart Object** in Gather and copy its **webhook URL** and **secret**.
2. Install and run gatherzap:

   ```sh
   npm i
   npm run ui
   ```

3. Open **http://127.0.0.1:3210** and scan the WhatsApp QR code.
4. Paste your Gather object's webhook URL and secret, then click **Save and continue**.
5. Choose the groups to track. Keep the app running to update your paper stack.
