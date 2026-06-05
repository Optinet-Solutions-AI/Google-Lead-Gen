"""
One-time Telegram session-string generator (Telethon).

Run this ONCE, interactively, to log a Telegram account in and produce a
StringSession that telegram_search.py reuses headlessly (no re-login per run).

Prereqs:
  1. Create a Telegram API app at https://my.telegram.org → "API development
     tools" → fill any app name/short-name → note the **api_id** and **api_hash**.
  2. A Telegram account + its phone number (a BURNER is recommended — automated
     search can draw rate-limits/bans on a personal account).

Run on a VM (telethon is installed there):
  python3 ~/gen_telegram_session.py

It will prompt for:
  - api_id, api_hash
  - phone number (international format, e.g. +614…)
  - the login code Telegram sends you (in the Telegram app / SMS)
  - your 2FA password, if the account has one

Then it prints the SESSION STRING. Put all three into ~/.env on EACH VM:
  TELEGRAM_API_ID=...
  TELEGRAM_API_HASH=...
  TELEGRAM_SESSION=<the long string this prints>

Keep the session string secret — it's full account access. Never commit it.
"""

from telethon.sync import TelegramClient
from telethon.sessions import StringSession


def main() -> None:
    api_id = int(input("api_id: ").strip())
    api_hash = input("api_hash: ").strip()
    print("\nLogging in — you'll be asked for your phone, the login code, and 2FA password if set.\n")
    with TelegramClient(StringSession(), api_id, api_hash) as client:
        me = client.get_me()
        print(f"\n[OK] logged in as {getattr(me, 'username', None) or me.first_name} (id {me.id})")
        print("\n===== TELEGRAM_SESSION (paste into ~/.env on all 3 VMs) =====\n")
        print(client.session.save())
        print("\n===== END — keep this secret =====")


if __name__ == "__main__":
    main()
