# 💵 Divi — Dólar BCV vs Binance + Peso colombiano

App (PWA instalable) que te muestra:

- **Bolívar:** tasa **BCV oficial** vs **Binance (venta/compra)** y el **% que te ahorras** comprando al BCV.
- **Peso colombiano:** USD→COP en **Binance (venta/compra)** + tasa oficial de referencia, con su variación.
- **Gráficas** del comportamiento intradía e histórico (el dólar Binance sube y baja durante el día, por eso se mide cada hora).
- **Avisos por Telegram** cuando el ahorro se mueve o cambia el BCV.
- **Alertas personalizadas** que tú defines (te aviso cuando una tasa llega a un valor).
- **Semáforo "¿buen día para comprar?"** 🟢🟡🔴 según el ahorro de hoy vs su promedio reciente.
- **Calculadora** Bs ↔ USD ↔ COP al instante (BCV y Binance).
- **Noticias** del dólar/BCV (titulares automáticos).

> Ejemplo del cálculo: BCV `554,43` y Binance `730,30` →
> `(730,30 − 554,43) / 730,30 = 24,08%` de ahorro comprando al BCV. ✅

Todo corre **gratis**: Firebase Hosting (web) + GitHub Actions (motor horario, sin tarjeta).

---

## 🗂️ Estructura

```
divi/
├─ public/                 ← lo que se publica en Firebase Hosting (la app)
│  ├─ index.html
│  ├─ styles.css
│  ├─ app.js               ← lógica, gráficas y % de ahorro
│  ├─ sw.js                ← service worker (offline / instalable)
│  ├─ manifest.webmanifest
│  ├─ icons/               ← íconos PNG generados
│  └─ data/history.json    ← historial de tasas (lo actualiza el cron)
├─ scripts/
│  ├─ update-rates.mjs     ← motor: consulta tasas, guarda historial, avisa por Telegram
│  └─ gen-icons.mjs        ← genera los íconos (sin dependencias)
├─ .github/workflows/
│  └─ update-rates.yml     ← cron horario en GitHub Actions
├─ firebase.json / .firebaserc
└─ package.json
```

---

## ✅ Requisitos

- **Node 20+** (ya lo tienes) y **Git** (ya lo tienes).
- Una cuenta gratis de **Google/Firebase** y otra de **GitHub**.
- (Opcional) **Telegram** para los avisos.

---

## ▶️ 1) Probar en tu PC

```powershell
# genera los íconos (solo la primera vez)
npm run icons

# trae datos reales una vez (rellena public/data/history.json)
npm run update

# abre la app en local
npx serve public        # o:  npm run serve  (requiere firebase-tools)
```

Abre la URL que te muestre (ej. `http://localhost:3000`).

---

## 🔥 2) Subir a Firebase Hosting (gratis)

1. Crea un proyecto en <https://console.firebase.google.com> (botón **Agregar proyecto**). Anota el **Project ID**.
2. Instala la herramienta e inicia sesión:
   ```powershell
   npm install -g firebase-tools
   firebase login
   ```
   > Si `firebase login` pide abrir el navegador, en este chat puedes escribir `! firebase login` para que se ejecute aquí.
3. Pon tu Project ID en **`.firebaserc`** (reemplaza `PON-AQUI-TU-PROJECT-ID`).
4. Despliega:
   ```powershell
   npm run deploy        # = firebase deploy --only hosting
   ```
5. Te dará una URL tipo `https://TU-PROYECTO.web.app`. Ábrela en el celular y usa **“Agregar a pantalla de inicio”** para instalarla como app. 📱

---

## ⚙️ 3) El motor automático (GitHub Actions, gratis y sin tarjeta)

El historial de la gráfica y los avisos los genera `scripts/update-rates.mjs`, que GitHub corre **cada hora**.

1. Sube el proyecto a un repositorio de GitHub:
   ```powershell
   git init
   git add .
   git commit -m "Divi: primera versión"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/divi.git
   git push -u origin main
   ```
2. En GitHub: **Settings → Secrets and variables → Actions → New repository secret** y crea (opcional, solo para Telegram):
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
3. Ve a la pestaña **Actions**, habilita los workflows y pulsa **Run workflow** en *“Actualizar tasas (Divi)”* para probarlo ya. De ahí en adelante corre solo cada hora.

Cada corrida añade un punto a `public/data/history.json` y hace commit.

### Que la app lea siempre el dato más fresco

Tienes dos opciones (elige una):

- **A) Re-desplegar Firebase tras cada update** (más simple de entender). Deja `REMOTE_DATA_URL = ""` en `app.js`.
- **B) Leer el JSON directo de GitHub** (recomendado, no re-despliegas). En `public/app.js` pon:
  ```js
  const REMOTE_DATA_URL =
    "https://raw.githubusercontent.com/TU_USUARIO/divi/main/public/data/history.json";
  ```
  Vuelve a desplegar **una vez** y listo: la app tomará los datos nuevos de cada corrida sin re-deploy.

---

## 🤖 4) Bot de Telegram (avisos)

1. En Telegram abre **@BotFather** → `/newbot` → te da el **TOKEN** (`TELEGRAM_BOT_TOKEN`).
2. Abre tu nuevo bot y mándale cualquier mensaje (para “activarlo”).
3. Abre **@userinfobot** → te da tu **chat id** (`TELEGRAM_CHAT_ID`).
4. Pon ambos como *secrets* en GitHub (paso 3.2).

El aviso se manda cuando el **ahorro se mueve ≥ 0,8 puntos** o cuando **cambia el BCV** (ajustable con la variable `ALERT_THRESHOLD`). Para forzar un aviso de prueba en local:

```powershell
$env:TELEGRAM_BOT_TOKEN="123:abc"; $env:TELEGRAM_CHAT_ID="111"; $env:FORCE_ALERT="1"; node scripts/update-rates.mjs
```

---

## 🔔 5) Alertas personalizadas (tú las pones)

En la pestaña **🔔 Alertas** de la app puedes decir, por ejemplo, *“avísame cuando Binance venta llegue a 750”*. El aviso llega por **Telegram** aunque la app esté cerrada. **Avisa una vez y se desactiva** (la reactivas cuando quieras).

**Cómo funciona por dentro:** la app arma un comando y lo manda a tu bot con un toque. El cron, en su corrida horaria, **lee tus comandos** (`getUpdates`), guarda las alertas en `public/data/alerts.json` y las evalúa contra la tasa del momento. Por eso una alerta nueva puede tardar **hasta 1 hora** en quedar registrada y en dispararse.

### Para que el botón “Crear alerta” abra Telegram solo
Pon el **usuario de tu bot** (sin `@`) en `public/app.js`:
```js
const TELEGRAM_BOT_USERNAME = "TuBot";   // el @usuario que le diste en BotFather
```
Si lo dejas en `""`, el botón **copia el comando** y tú lo pegas en el chat del bot.

### También puedes manejarlo por chat (comandos del bot)
```
/alerta venta mayor 750   → avisa si Binance venta ≥ 750
/alerta bcv menor 550     → avisa si el BCV ≤ 550
/alerta ahorro mayor 26   → avisa si el ahorro ≥ 26 %
/lista                    → ver tus alertas
/borrar 1                 → borrar la alerta nº 1
/activar 1                → reactivar la alerta nº 1
/avisos off               → silenciar TODAS las notificaciones
/avisos on                → reactivarlas
```
Vigilables: `venta`, `compra`, `bcv`, `ahorro`, `copventa`, `copcompra`.

### Activar/desactivar notificaciones
El interruptor de la pestaña Alertas (o `/avisos off`) **silencia todo**: ni el aviso horario ni las alertas. Mientras está apagado, **tus alertas no se consumen** — siguen ahí para cuando lo vuelvas a encender.

> Nota: el bot solo obedece comandos enviados desde **tu** chat (`TELEGRAM_CHAT_ID`); ignora a cualquier otro.

---

## 📊 Fuentes de datos

| Dato | Fuente | Respaldo |
|------|--------|----------|
| BCV oficial | `ve.dolarapi.com` | `pydolarve.org` |
| Binance VES (venta/compra) | Binance **P2P** (USDT/VES) | paralelo de `dolarapi` |
| Binance COP (venta/compra) | Binance **P2P** (USDT/COP) | — |
| USD→COP oficial | `open.er-api.com` | — |

> **venta** = a cómo *compras* USDT (lo que pagas por el dólar). **compra** = a cómo *vendes* USDT (lo que te dan).

---

## 📱 6) Llevarla a Play Store / App Store (cuando quieras monetizar)

La app está hecha **“Capacitor-ready”**: el mismo código de `public/` se empaqueta como app nativa sin reescribir nada.

- **Capacitor** → genera el `.aab` (Android) y el proyecto iOS (necesita una Mac o un servicio en la nube para compilar).
- **AdMob** (`@capacitor-community/admob`) → anuncios *banner / intersticial / rewarded* en ambas tiendas.
- Costos: Google Play **$25 una vez**, App Store **$99/año**. AdMob es gratis (ahí ganas).
- Hace falta una **política de privacidad** (la alojamos gratis en Firebase Hosting).

Cuando decidas dar el salto, se añade Capacitor + AdMob **encima** de lo actual, sin tocar la lógica.

---

## 🧰 Comandos rápidos

| Comando | Qué hace |
|---------|----------|
| `npm run icons` | Genera los íconos PNG |
| `npm run update` | Trae tasas reales y actualiza el historial |
| `npm run serve` | Sirve la app en local (firebase) |
| `npm run deploy` | Publica en Firebase Hosting |
