import asyncio
import base64
import io
import json
import logging
import os
import random
import re
import string
import zipfile
from pathlib import Path

import httpx
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ConversationHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

NAME, LOGO, APK = range(3)
UPLOADS = Path("uploads")

import warnings
from telegram.warnings import PTBUserWarning

warnings.filterwarnings("ignore", category=PTBUserWarning)

logging.basicConfig(format="%(asctime)s %(levelname)s %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)


def load_local_env() -> None:
    env_file = Path(".env.local")
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key.strip() and not key.strip().startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def safe_slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]", "", value.lower())
    return slug[:40] or "app"


def extract_package_name_from_bytes(data: bytes, fallback_slug: str) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if "AndroidManifest.xml" in z.namelist():
                manifest = z.read("AndroidManifest.xml")
                matches = re.findall(rb"[a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+", manifest)
                for m in matches:
                    decoded = m.decode("latin1", errors="ignore")
                    if decoded.startswith(("com.", "org.", "net.", "io.", "in.", "co.")) and len(decoded.split(".")) >= 2:
                        return decoded
    except Exception as e:
        logger.warning("Could not extract package name from APK bytes: %s", e)
    return f"com.{safe_slug(fallback_slug)}"


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text("✅ Process started\n\n1/3 App ka naam Bhejiye.")
    return NAME


async def new_link_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data.clear()
    await query.message.reply_text("✅ Process restarted\n\n1/3 App ka naam Bhejiye.")
    return NAME


async def get_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["name"] = update.message.text.strip()
    await update.message.reply_text("✅ 1/3 App name received\n\n2/3 Ab app ka icon image Bhejiye.")
    return LOGO


async def get_logo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    logo_file_id = None
    if update.message.photo:
        photos = update.message.photo
        # Telegram sends multiple sizes: choose optimal icon resolution (~320px to 800px)
        # Avoid multi-megabyte raw photos that slow down web loading
        if len(photos) >= 3:
            logo_file_id = photos[1].file_id
        elif len(photos) == 2:
            logo_file_id = photos[1].file_id
        else:
            logo_file_id = photos[0].file_id
    elif update.message.document and update.message.document.mime_type and update.message.document.mime_type.startswith("image/"):
        logo_file_id = update.message.document.file_id
    else:
        await update.message.reply_text("Please logo image Bhejiye, phir main next step par jaunga.")
        return LOGO

    context.user_data["logo_file_id"] = logo_file_id

    # Download logo bytes and convert to inline Base64 data URL
    try:
        logo_file = await context.bot.get_file(logo_file_id)
        logo_bytes = await logo_file.download_as_bytearray()
        ext = (logo_file.file_path or "").lower()
        mime = "image/png" if ext.endswith(".png") else ("image/webp" if ext.endswith(".webp") else ("image/svg+xml" if ext.endswith(".svg") else "image/jpeg"))
        context.user_data["logo_base64"] = f"data:{mime};base64,{base64.b64encode(bytes(logo_bytes)).decode('utf-8')}"
    except Exception as err:
        logger.warning("Could not download logo bytes in get_logo: %s", err)
        context.user_data["logo_base64"] = ""

    await update.message.reply_text("✅ 2/3 App icon received\n\n3/3 Ab APK document Bhejiye. Filename kuch bhi ho sakta hai.")
    return APK


async def get_apk(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    document = update.message.document
    if not document:
        await update.message.reply_text("APK document ke roop me Bhejiye. Process continue karne ke liye /start bhi bhej sakte hain.")
        return APK

    status = await update.message.reply_text("✅ 3/3 APK received\n⏳ Analyzing APK & preparing your app page...")
    user_id = str(update.effective_user.id)
    publish_url = os.getenv("PUBLISH_URL")
    publish_secret = os.getenv("PUBLISH_SECRET")

    # Extract Package Name from Telegram APK Document
    package_name = f"com.{safe_slug(context.user_data['name'])}"
    try:
        apk_file = await context.bot.get_file(document.file_id)
        apk_bytes = await apk_file.download_as_bytearray()
        package_name = extract_package_name_from_bytes(bytes(apk_bytes), context.user_data["name"])
    except Exception as err:
        logger.warning("Could not download APK bytes for manifest reading: %s", err)

    # Inline Buttons for Help & New Link
    keyboard = [
        [
            InlineKeyboardButton("🆘 Help", url="https://t.me/sanaminfotech"),
            InlineKeyboardButton("➕ New Link", callback_data="new_link"),
        ]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)

    if publish_url and publish_secret:
        await status.edit_text("✅ 3/3 APK received\n⏳ Uploading files & deploying your app page...")
        payload = {
            "name": context.user_data["name"],
            "logoFileId": context.user_data["logo_file_id"],
            "logoBase64": context.user_data.get("logo_base64", ""),
            "apkFileId": document.file_id,
            "packageName": package_name,
            "userId": user_id,
        }
        try:
            async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
                result = await client.post(publish_url, json=payload, headers={"x-publish-secret": publish_secret})
                if result.status_code == 200:
                    published = result.json()
                    await status.edit_text(
                        f"✅ Files uploaded\n✅ Page deployed & READY!\n\n🔗 {published['url']}",
                        reply_markup=reply_markup,
                    )
                    context.user_data.clear()
                    return ConversationHandler.END
                else:
                    logger.warning("Vercel publish response status %s: %s", result.status_code, result.text)
        except Exception as error:
            logger.warning("Vercel publish network call error: %s", error)

    # Local Backup Fallback
    rand_suffix = "".join(random.choices(string.ascii_lowercase + string.digits, k=5))
    slug = f"{safe_slug(context.user_data['name'])}-{rand_suffix}"
    app_dir = UPLOADS / slug
    app_dir.mkdir(parents=True, exist_ok=True)

    try:
        logo_file = await context.bot.get_file(context.user_data["logo_file_id"])
        await logo_file.download_to_drive(custom_path=str(app_dir / "logo"))
        apk_file = await context.bot.get_file(document.file_id)
        await apk_file.download_to_drive(custom_path=str(app_dir / "base.apk"))

        record = {
            "name": context.user_data["name"],
            "slug": slug,
            "package_name": package_name,
            "logo_path": str(app_dir / "logo"),
            "apk_path": str(app_dir / "base.apk"),
            "telegram_user_id": user_id,
        }
        (app_dir / "app.json").write_text(json.dumps(record, indent=2, ensure_ascii=True), encoding="utf-8")
        await update.message.reply_text(
            f"✅ Details received & saved locally!\n\nApp: {record['name']}\nPackage: {package_name}\n📁 Local backup: {app_dir}",
            reply_markup=reply_markup,
        )
    except Exception as exc:
        logger.error("Failed to save local backup: %s", exc)
        await update.message.reply_text("⚠️ App processing completed with local backup.", reply_markup=reply_markup)

    context.user_data.clear()
    return ConversationHandler.END


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.message.reply_text("Process cancel ho gaya. Dobara shuru karne ke liye /start Bhejiye.")
    return ConversationHandler.END


async def handle_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error("Update error: %s: %s", type(context.error).__name__, context.error)


def main() -> None:
    load_local_env()
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not token or token.startswith("PASTE_"):
        raise SystemExit("TELEGRAM_BOT_TOKEN environment variable set kijiye.")

    # Initialize event loop for Python 3.12+ / 3.14+
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

    application = Application.builder().token(token).build()
    conversation = ConversationHandler(
        entry_points=[
            CommandHandler("start", start),
            CallbackQueryHandler(new_link_callback, pattern="^new_link$"),
        ],
        states={
            NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, get_name)],
            LOGO: [MessageHandler(filters.PHOTO | filters.Document.IMAGE, get_logo)],
            APK: [MessageHandler(filters.Document.ALL, get_apk)],
        },
        fallbacks=[
            CommandHandler("cancel", cancel),
            CommandHandler("start", start),
            CallbackQueryHandler(new_link_callback, pattern="^new_link$"),
        ],
        per_message=False,
        per_chat=True,
        per_user=True,
    )
    application.add_handler(conversation)
    application.add_handler(CallbackQueryHandler(new_link_callback, pattern="^new_link$"))
    application.add_error_handler(handle_error)
    logger.info("Telegram app collection bot started")
    application.run_polling(allowed_updates=Update.ALL_TYPES, close_loop=False)


if __name__ == "__main__":
    main()

