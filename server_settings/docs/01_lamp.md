# 01. LAMP hosts

Lives in the **server** repo (`server_settings/`). Three PHP vhosts on :80 plus the Node game on loopback. Content-manager is PHP. Play is `/play` on www. Frontend stays a thin front controller until a later Symfony conversion.

## Do not

- Node HTTP in `frontend/` `map-editor/` `content-manager/`.
- Symfony scaffolding until asked.
- Extract a play vhost until asked.
- Public bind for editor/manager.
- Serve `.git`, `config/`, `php/`, `tests/`, `src/`, `bin/`, `node_modules/`, `settings.local.json`.
- `ServerAlias *.example.com` on these vhosts.

## Hosts

| Host | Folder | Process | Access |
| :--- | :--- | :--- | :--- |
| `www.example.com` | `frontend/` | PHP | this box, :80 (accounts + `/play`) |
| `editor.example.com` | `map-editor/` | PHP | **loopback only** |
| `manage.example.com` | `content-manager/` | PHP | **loopback only** |
| (no vhost) | `server/` | **Node** `127.0.0.1:8081` | loopback |

`/etc/hosts`: `127.0.0.1 www.example.com editor.example.com manage.example.com`

## Pins

| Knob | Value |
| :--- | :--- |
| HTTP | **80** (TLS later) |
| Game | **`http://127.0.0.1:8081`** |
| WS proxy | Apache `/v1/ws` → `ws://127.0.0.1:8081/v1/ws` (`mod_proxy_wstunnel`) |
| `/v1` REST | PHP curl on www (`proxyApi`) |
| editor/manage | Apache `Require local` + PHP `allowRemote: false` |
| manage frames | `X-Frame-Options SAMEORIGIN` (wiki iframe). www/editor stay `DENY` |
| editor body | **32 MiB** (`LimitRequestBody` + `post_max_size`) for hybrid `map.json` |
| Conf | `server_settings/apache/vhost.conf` |

## Enable

```bash
sudo a2enmod rewrite headers proxy proxy_http proxy_wstunnel
sudo ln -sf /media/thiago/data/www/grok/dungeon-engine/server/server_settings/apache/vhost.conf \
     /etc/apache2/sites-available/engine.conf
sudo a2ensite engine.conf
sudo apache2ctl configtest && sudo systemctl reload apache2
```

This agent cannot write `/etc/apache2` (no root). Copy the conf as root.

Existing `example.conf` `ServerAlias *.example.com` → `/var/www/mit/public` (other product). Exact `ServerName` in `vhost.conf` wins for the three names. Drop `play.example.com` from `/etc/hosts` so it does not fall through to that wildcard.

When Apache is serving these hosts, do not also run `php bin/serve.php` on 8080/8082/8083. Keep `cd server && npm start`.

`www-data` must be able to read the three DocumentRoots. Editor/manager PUT also needs write on `content/maps`, `content/items`, `content/creatures`, `content/npcs`. Do not DocumentRoot `content/`. www PHP may **read** pack sprites + hybrid `sub_*` for `GET /sprites/` and `GET /visual` (floor window only).

Overlays: `examples/*.json` → each module `config/settings.local.json`.

## Later (do not start)

| Item | Note |
| :--- | :--- |
| Symfony on www | Replace thin `frontend/` PHP with a Symfony app. Accounts still proxy `/v1` to Node. `/play` stays on www until asked. No game tick in PHP. |
| TLS :443 | Then `cookieSecure` on the game, `wss://` in overlays |
| Editor/manager off-box | HTTP auth first; keep `allowRemote` false until then |
