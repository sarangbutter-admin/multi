# Android app (Capacitor wrapper)

One shared app: customers pick a store, the store's theme is applied, and every call goes to your platform API.
The wrapper reuses `../public` unchanged. Only `config.js` differs (`window.SO_API` = your site).

Status: **configuration only.** It was not built or run here (no Android SDK / package installs in the build environment). Follow the steps on a computer with Node 18+, JDK 17 and Android Studio.

## Build
```
cd mobile
npm install
PLATFORM_URL=https://order.example.com npm run prepare:www
npx cap add android          # first time only
npx cap sync android
npx cap open android         # Android Studio → Build → Generate Signed Bundle / APK
```
After any change in `public/`, run `PLATFORM_URL=... npm run sync` again.

## Server settings the app needs
- `APP_ORIGINS=capacitor://localhost,https://localhost` on Netlify (CORS for the app; already in `.env.example`).
- The app sends `X-Tenant: <store slug>` and a Bearer token, no cookies.

## Known edges to check on a device
- Payments open the gateway page inside the app; when the customer finishes, the gateway returns to `PUBLIC_BASE_URL/order/<no>` in the web version. Use "My orders" in the app to see the status. (Next step if wanted: Capacitor Browser plugin + deep link back.)
- App icon / splash: replace with your own via `@capacitor/assets`; `public/icon.svg` is a placeholder.
- Store back office stays on the web at `/admin` (not in the app).
