# ColorWay: one color, your whole look

ColorWay is a web app for the eCommerce VTO category of the YouCam API Skin AI &
eCommerce VTO Hackathon on Devpost. You pick **one color** and add four photos (face,
hand, full body, plain garment). ColorWay turns that color into four try-ons with four
YouCam APIs: a color option for Nail VTO, Makeup VTO (lip color) and Hair Color, plus a
recolored garment image for Clothes VTO v3. It estimates the color that comes back on each
surface and re-renders the surfaces that score below 85. The results land on one board
that can be saved as one image.

Requires **Node.js 20 or later**. There are no npm dependencies, installs, builds,
external fonts, or browser frameworks.

## YouCam APIs used

| Surface | YouCam API | How ColorWay uses it |
| --- | --- | --- |
| Nails | Nail VTO | One hex color per finger from a photo of the back of a hand. |
| Lips | Makeup VTO, lip color | The chosen color as the lip color on a face photo. |
| Hair | Hair Color, ombre | Two-color ombre (dark brown, then the chosen color) so the color sits on the tips. |
| Outfit | Clothes VTO v3 | Tries a garment image on a full-body photo (upper body). |

## How it works

- **Measurement runs in the browser.** For each result, the app takes the average
  rendered color of that surface. It keeps only the pixels whose CIELAB hue is within
  20 degrees of the target and whose chroma is at least half of the target's (and at
  least 20). This is a color filter, not a surface mask: similar colors elsewhere in the
  image can enter the average, and when no pixel passes the app shows no score. It
  converts that average to CIELAB and
  computes the **CIEDE2000** distance to the target. The 0 to 100 match score is
  ColorWay's own scale (100 at a distance of 0, 0 at a distance of 30), not a YouCam
  metric.
- **Match better.** A surface counts as off below a match score of 85. The Match better
  button re-renders only those surfaces, each with a corrected input color calculated
  in CIELAB (the next input moves by 0.8 times the measured gap, capped at 25 per
  channel). Each surface gets at most three renders and stops as soon as its score stops
  improving, so improvement is not guaranteed and a surface can end below 85; when nothing
  is left to try, the page names the surfaces that stopped. Surfaces at 85 or above are
  left alone.
- **Outfit path.** Clothes VTO v3 tries on a garment image rather than a color, so the
  app first recolors your photo of a plain garment to the target color in the browser,
  then sends that recolored garment together with the full-body photo.
- **Server.** A zero-dependency Node.js server keeps the YouCam API key on the server
  only, gates the app behind a shared passcode, queues the tasks, stores each result as
  soon as it arrives (the provider's result URLs expire), and logs estimated unit usage.
- **Calibration results.** In one run on the sample images in YouCam's API documentation
  (not included in this repository; target #C8102E, one Match better pass), lips went from
  ΔE 5.0 to 2.4 (score 83 to 92), hair from 10.7 to 8.8 (64 to 71) and outfit from 11.7 to
  9.3 (61 to 69); nails were already at ΔE 3.2 (score 89) and were left alone. In one run
  on the AI-generated photos in `samples/`, nails scored 88, lips 86 and outfit 97, and one
  pass moved hair from 70 to 73 (ΔE 9.1 to 8.1). ΔE is CIEDE2000. Each is a single run,
  not a benchmark.

## Run

From this directory, in **mock mode** (the default; no API calls and no API key):

```sh
APP_PASSCODE='choose-a-private-passcode' DATA_DIR="$HOME/youcam-data" node server.mjs
```

Open `http://127.0.0.1:8787`, sign in with the passcode, and open `/colorway`. Pick a
color, then add photos for the surfaces you want (see `samples/` for photos to try).
In mock mode the server makes no YouCam calls: it simulates running and success and
returns the uploaded photo unchanged as a placeholder result, so no score is shown and the
images are not YouCam results. Use it to explore the interface.

In **live mode**, photos are sent to the YouCam API and tasks consume API units. Set
`MODE=live`, `APP_PASSCODE`, `DATA_DIR` and `YOUCAM_API_KEY` in the server's environment
from your secret store (not typed into the command line, where they would stay in shell
history), then start:

```sh
node server.mjs
```

`DATA_DIR` must be an absolute path **outside this directory**. Paths that resolve back
inside it through a symlink are rejected. The server creates the storage directory. By
default the server binds to `127.0.0.1`; set `HOST` to listen elsewhere. A hosted
deployment needs an HTTPS reverse proxy that preserves the public host so same-origin
checks continue to work. See "Running on Cloud Run".

## Environment variables

| Variable | Meaning |
| --- | --- |
| `MODE` | `mock` (default) or `live`. |
| `APP_PASSCODE` | Required shared passcode; keep it private. |
| `DATA_DIR` | Required absolute path outside the app for photos, results and usage. |
| `YOUCAM_API_KEY` | Required only in live mode; used exclusively on the server. |
| `SESSION_SECRET` | Optional HMAC signing secret. Without it, a random secret is generated each start. |
| `PORT` | Port number, default `8787`. |
| `HOST` | Address to listen on, default `127.0.0.1`. Use `0.0.0.0` inside a container. |
| `RETENTION_HOURS` | Hours to keep photos and results, default `24`. Must be a positive number; otherwise the server refuses to start. |
| `TRUST_PROXY` | Set to `1` behind a proxy that ends TLS: the login cookie then gets `Secure` when `x-forwarded-proto` is `https`. Unset by default. |
| `YOUCAM_BASE_URL` | Default `https://yce-api-01.makeupar.com`; tests use a local fake server. |

No `.env` file is automatically loaded. Supply secrets securely in the server's
environment, never in source files, URLs, shell history, or browser JavaScript.

## Running on Cloud Run

The `Dockerfile` builds an image that listens on `0.0.0.0:$PORT` (8080) with
`MODE=live`, `TRUST_PROXY=1` and `DATA_DIR=/tmp/colorway-data`. `/tmp` is the
container's in-memory scratch space, so photos and results vanish when the instance
stops, which fits the retention cleanup.

- Allow **at most one instance** (max instances 1). Sessions, uploads, jobs and the
  queue live in one process's memory, and a second instance would not know them.
- Scaling to zero when idle is fine, but a stopped instance loses any board that is
  still in progress; keep a minimum of one instance during use if that matters.
- Supply `APP_PASSCODE`, `SESSION_SECRET` and `YOUCAM_API_KEY` as environment
  variables taken from Secret Manager at deploy time. They are not in the image.
- `usage.jsonl` also lives under `/tmp`, so the persisted usage totals reset when the
  instance is replaced.

## Test

```sh
node --test test/*.test.mjs
```

Tests start their own localhost fake YouCam server, including upload instructions,
byte upload, task creation, running-to-success polling, and result downloads. Mock
tests inject a fetch function that fails if called. No test contacts a real API.
Tests use synthetic image bytes only. They create an isolated app copy beneath
`.test-work/` and keep its `DATA_DIR` beside that copy, then remove their own fixture.

Some sandboxed environments deny localhost listeners with `listen EPERM`. The genuine
socket tests remain enabled and report that failure. Separately labelled checks can
still execute the real app handlers and client with in-process HTTP transport:

```sh
node --test test/inprocess.test.mjs
```

These supplemental checks do not establish that socket integration works.

## Privacy and storage

- Actual user photos and results belong only in the external `DATA_DIR`, outside
  the repo. Layout: `photos/<uuid>.jpg|png`, `results/<provider-task-id>/` (downloaded
  files and `metadata.json`), and `usage.jsonl` (no images or keys).
- In live mode, the API provider receives the uploaded images and retains uploaded
  files for about **30 days**, according to the supplied documentation. Mock mode
  keeps processing local.
- Local photos and results are deleted automatically once older than
  `RETENTION_HOURS` (default 24). The age is counted from when the photo was uploaded
  or the task was created, not from last use. A cleanup runs right after start (it
  judges leftover files from an earlier start by modification time) and every
  10 minutes. Tasks still running, and the photos they use, are kept. `usage.jsonl`
  is never deleted. This covers only local copies; the API provider's own retention
  (about 30 days) is unchanged. New directories/files use restrictive permissions,
  but an already-existing storage directory retains its existing permissions.
- Job and upload lookup tables are in memory. Restarting preserves stored files
  (until the cleanup removes them) and usage totals, but resets the browser's
  job/download lookup. Without `SESSION_SECRET`, restarting also invalidates login
  cookies.
- API keys are never sent to the browser or written to logs, responses or files.
  Upstream error bodies are discarded. The optional debug redactor masks
  `Authorization` and the configured secret. Result content containing the API key
  is rejected before storage.
- No secrets belong in the repo. `.gitignore` excludes `.env`, `data/`,
  `node_modules/`, and temporary test fixtures. Do not expose `DATA_DIR` as a static
  web directory; access stored results through the authenticated server routes.

## Sample photos

`samples/` holds four AI-generated photos you can use to try the app in mock or live
mode. They show no real person. See [samples/README.md](samples/README.md).

## License

[MIT](LICENSE)
