# 📖 Purdue Hackers Directory

A place for Purdue Hackers members to search and connect with other Purdue Hackers members and alumni.

Built with **Bun** and **Astro (SSR)**, powered by **Purdue Hackers ID**, and styled with the official **Purdue Hackers UI** design system.

## ✨ Features

- **Purdue Hackers ID Authentication**: Seamless sign-in via OIDC with PKCE. All signed-in ID members have access to the directory.
- **Fast Member Search**: Instant fuzzy text search matching full names, `@usernames`, emails, and Discord tags via MiniSearch.
- **Role & Grad Year Filtering**: Filter quickly across Organizers, Alumni, Admins, or by graduation class.
- **Member Profiles & Customization**: Detailed profile view at `/u/[username]` displaying avatars, role badges, graduation class, and direct contact options (email, phone, Discord). Members can customize their Directory-specific profile (personal website, social accounts, custom external links, location, timezone with live clock, headline, and bio) at `/settings/profile`.
- **Fuzzy Search with Location & Bios**: Instant search matching names, `@usernames`, emails, Discord tags, locations (e.g. "San Francisco", "West Lafayette"), headlines, and bios via MiniSearch.
- **Local SQLite / LibSQL Persistence**: Community profile data lives entirely within Directory SQLite/LibSQL and is never synced back to ID, keeping identity and community expression cleanly partitioned.
- **Official Purdue Hackers Design**: Follows official PH brand guidelines (Pixel Hackers, PolySans, and Inconsolata typography, cream background, crisp 1px hairlines, HackerNoon pixel icons, and zero rounded corners).
- **Server Caching & Webhook Sync**: Member data cached in memory with automatic invalidation via `/api/webhooks/id`.

## 🛠️ Tech Stack

- **Runtime & Package Manager**: [Bun](https://bun.sh)
- **Framework**: [Astro 7](https://astro.build) (SSR mode)
- **Database & ORM**: LibSQL (`@libsql/client`) + [Drizzle ORM](https://orm.drizzle.team) (SQLite/Turso)
- **Styling**: Tailwind CSS v4 + Purdue Hackers Theme (`ph.css`)
- **Search Engine**: [MiniSearch](https://github.com/lucaong/minisearch)
- **Adapter**: `@astrojs/vercel` (serverless deployment on Vercel)

## 🚀 Getting Started

### 1. Install dependencies

```sh
bun install
```

### 2. Configure environment variables

Copy `.env.example` to `.env`:

```sh
cp .env.example .env
```

| Variable         | Description                                              | Default                    |
| ---------------- | -------------------------------------------------------- | -------------------------- |
| `ID_BASE`        | Purdue Hackers ID provider origin                        | `http://localhost:5173`    |
| `CLIENT_ID`      | OAuth 2.0 client ID registered in ID                     | `directory-service`        |
| `CLIENT_SECRET`  | OAuth 2.0 client secret for confidential token access    | `directory-secret`         |
| `PUBLIC_URL`     | Public origin of this directory instance                 | `http://localhost:4321`    |
| `SESSION_SECRET`     | Secret key used to sign session cookies                  | `super-secret-key-...`     |
| `WEBHOOK_SECRET`     | Secret token to authenticate cache-invalidation webhooks | `directory-webhook-secret` |
| `TURSO_DATABASE_URL` | LibSQL database URL (local SQLite or Turso cloud)        | `file:./data/directory.db` |
| `TURSO_AUTH_TOKEN`   | Turso database authentication token (production only)    | None                       |

### 3. Run development server

Start the dev server:

```sh
astro dev --background
```

Manage the server with:

- `astro dev status`
- `astro dev logs`
- `astro dev stop`

Or run in foreground:

```sh
bun run dev
```

Visit [http://localhost:4321](http://localhost:4321).

### 4. Run tests

```sh
bun test
```

## 🔐 ID Integration & Permissions

Directory uses two OAuth 2.0 flows against Purdue Hackers ID:

1. **User Sign-In (Authorization Code + PKCE)**:
   - Scopes: `openid profile email roles phone`
   - Establishes a signed session cookie (`ph_dir_session`) for authenticated members.
2. **Directory Data Sync (`client_credentials`)**:
   - Scopes: `directory:roles directory:contact directory:discord`
   - Resource: `https://id.purduehackers.com/api/directory`
   - Queries `GET /api/directory/users` to sync directory members.
