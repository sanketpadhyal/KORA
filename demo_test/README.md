# Kora login demo

Run the demo from this directory:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Use the fake login details:

```text
Email: sanket@kora.dev
Password: kora123
```

The demo starts a local Kora engine on port `8081` and a fake application backend plus HTML page on port `3000`.

Each successful login stores a Kora key shaped like `session:<uuid>` with a 15-minute TTL. Every login attempt consumes one of five rate-limit slots in a 60-second window.
