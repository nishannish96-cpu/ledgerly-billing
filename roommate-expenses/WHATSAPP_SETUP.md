# WhatsApp account alerts

Roomies sends a WhatsApp template message to household users who have saved a phone number and explicitly opted in. Alerts are sent only after an admin creates an account. Passwords are never included. Users can change their number or opt out from the **WhatsApp account alerts** section.

## Meta setup

1. Configure a WhatsApp Business Cloud API sender in Meta and create an approved **Utility** message template.
2. Use a body with these two text placeholders, in order:

   `Roomies update: A new account for {{1}} ({{2}}) was created in your household.`

   The first value is the member name and the second is the new username. Set the approved template name and language exactly as shown in Meta.
3. In the Render service's environment settings, set these values. Keep the access token private; do not put it in source control or chat.

   - `WHATSAPP_ACCESS_TOKEN`: a valid Cloud API access token
   - `WHATSAPP_PHONE_NUMBER_ID`: the sending phone number's ID
   - `WHATSAPP_GRAPH_API_VERSION`: a currently supported Graph API version, such as `vNN.0`
   - `WHATSAPP_TEMPLATE_NAME`: the approved template name
   - `WHATSAPP_TEMPLATE_LANGUAGE`: the approved template's language code, such as `en_US`

   The variable names are declared in the Render blueprint; secret values must be entered in Render.
4. Each user must save their number in international E.164 format (for example `+15551234567`) and check the consent box. A user's opt-in applies only to their own number and household.

If sending fails, account creation still succeeds. The admin sees a delivery warning and the server logs the failed delivery; correct the Meta configuration or recipient status before retrying with a later account creation.
