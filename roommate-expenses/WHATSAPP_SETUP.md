# WhatsApp notifications and household groups

Roomies can post an expense or settlement update to a household WhatsApp group after the event is saved. Group creation and invites use Meta's Groups API. That API requires an Official Business Account (OBA), a Cloud API business number, and an app subscribed to the WhatsApp messaging account. Group participants must join using an invite; the app cannot add them directly. Groups support up to eight participants, including the business number, so Roomies invites at most seven household users.

Users must save an E.164 phone number and separately opt in to direct account-creation messages and/or household group invites and messages. Roomies sends group invitations only to opted-in users. Never include a user's password in a WhatsApp message.

## Render environment

Set these variables in the Roomies Render service. Keep tokens, app secrets, and webhook verify tokens private; do not put their values in source control or chat.

- `WHATSAPP_ACCESS_TOKEN`: Cloud API access token with `whatsapp_business_messaging` permission
- `WHATSAPP_PHONE_NUMBER_ID`: Cloud API business phone-number ID
- `WHATSAPP_GRAPH_API_VERSION`: a currently supported Graph API version
- `WHATSAPP_APP_SECRET`: Meta app secret, used to validate webhook signatures
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: a long random value you choose and also enter in Meta's webhook setup
- `WHATSAPP_GROUP_INVITE_TEMPLATE_NAME`: approved group-invite template name
- `WHATSAPP_GROUP_INVITE_TEMPLATE_LANGUAGE`: approved template language code

The existing optional `WHATSAPP_TEMPLATE_NAME` and `WHATSAPP_TEMPLATE_LANGUAGE` settings are used for direct account-creation alerts.

## Meta setup

1. Make sure the business number is on WhatsApp Cloud API (not the WhatsApp Business app) and the business has OBA approval.
2. Set the webhook callback URL to `https://roomies-expenses.onrender.com/api/whatsapp/webhook`, enter the same value configured as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, and subscribe the app to `group_lifecycle_update`, `group_participants_update`, `group_settings_update`, and `group_status_update`. Subscribe the app to the business phone number's Messaging account and grant `whatsapp_business_messaging`.
3. In WhatsApp Manager's Template Library, add and get approval for a **Group invite link** template with **Group invite upon request** enabled. Enter its exact name and language in Render.
4. Each household user should enter their WhatsApp number in Roomies and check the separate group consent box.
5. A house admin selects **Create WhatsApp group**. Roomies creates an invite-only group. After Meta's creation webhook supplies its invite link, the admin can select **Send invites to opted-in members**. Members choose whether to join in WhatsApp.
6. Once at least one member has joined, Roomies posts expense and settlement notifications to the group. If sending fails, the expense or settlement remains saved and the UI displays a warning.

Meta's webhook must be reachable over HTTPS. The endpoint validates `X-Hub-Signature-256` using `WHATSAPP_APP_SECRET`; unsigned or invalid requests are rejected.
