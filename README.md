# Menú digital + pedidos a cocina

Archivos de esta carpeta (se suben a GitHub y Vercel los publica):
- `index.html`  → menú para clientes (`/?mesa=Mesa%203` para el QR de una mesa)
- `qr.html`     → hoja imprimible con un QR por mesa y uno para domicilios (`tu-sitio.vercel.app/qr`)
- `firebase-config.js` → pega aquí tu `firebaseConfig`
- `firestore.rules`    → reglas de seguridad (se pegan en Firebase)

## 1. Firebase (una sola vez)
1. Proyecto nuevo en console.firebase.google.com.
2. Compilación → **Firestore Database** → Crear base de datos (modo producción).
3. Compilación → **Authentication** → Comenzar → método **Correo/contraseña** → Activar.
   Pestaña *Usuarios* → Agregar usuario (tu correo y una contraseña): es la cuenta del POS.
4. Firestore → pestaña **Reglas** → pega el contenido de `firestore.rules` → Publicar.
5. Configuración del proyecto (⚙) → Tus apps → icono web `</>` → copia `firebaseConfig`.
6. Abre `firebase-config.js` y reemplaza los valores.

## 2. GitHub + Vercel
1. Crea un repositorio en GitHub y sube esta carpeta (index.html, qr.html, firebase-config.js, vercel.json; el README y las reglas son opcionales).
2. En vercel.com → Add New → Project → importa el repositorio → Deploy (sin cambiar nada).
3. Tu enlace queda como `https://tu-proyecto.vercel.app`.

## 3. POS
1. Abre `Punto_de_venta_con_pedidos_online.html` → ☰ → Configuración → **Pedidos online**.
2. Pega el `firebaseConfig`, escribe correo y contraseña de la cuenta del paso 1.3 → Conectar.
3. Escribe el enlace de Vercel y pulsa **Publicar menú ahora**.
4. Pulsa **Abrir hoja de QR** e imprímela.

Desde ahí, cada cambio de precio, foto, stock, mesa o modificador se publica solo.
Los pedidos llegan a Cocina con aviso sonoro, se imprimen y quedan en la mesa o ticket para cobrar.
