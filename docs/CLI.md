English · [中文](CLI.zh.md)

# Command-line reference

During development use `npm run turnwire -- ...`; after building you can run `node apps/cli/dist/main.js ...` directly, or add the corresponding workspace's `turnwire` / `turnwire-host` executables to your own PATH.

| Command | Purpose |
| --- | --- |
| `turnwire status` | Show device and runtime status |
| `turnwire ls --search KEYWORD` / `--archived` / `--all` | Search sessions and working directories; view archived ones |
| `turnwire rename SESSION_ID TITLE` | Rename a shared session |
| `turnwire archive SESSION_ID` / `turnwire unarchive SESSION_ID` | Archive and unarchive while keeping history |
| `turnwire history SESSION_ID` | View messages and full tool inputs and outputs |
| `turnwire agents SESSION_ID` | Watch the background agents a session has running: label, state, elapsed time, and their own todo progress |
| `turnwire approve-for-me SESSION_ID [--off]` | Grant that session's approvals as they arrive until you turn it off, then settle what is already waiting |
| `turnwire questions` | List the questions a running agent is waiting on, with the choices each one offers |
| `turnwire answer QUESTION_ID 'label' [--text 'written answer']` | Answer a pending question |
| `turnwire export SESSION_ID --output session.md` | Export a Markdown record |
| `turnwire new [prompt] --cwd /absolute/path --title TITLE` | Create a session; DSH by default |
| `turnwire models` | List the models registered by the current runtime, the default model and available thinking efforts |
| `turnwire model SESSION_ID provider/model [--effort EFFORT]` | Choose the model and thinking effort a session runs with; only accepts models in the runtime catalog |
| `turnwire attach SESSION_ID` | Read history and follow live output; in a TTY you can keep typing |
| `turnwire send SESSION_ID 'message'` | Send a follow-up message |
| `turnwire send SESSION_ID 'message' --steer` | Interject to steer a running turn; by default the message is queued until it finishes |
| `turnwire resume SESSION_ID` | Resume an interrupted session |
| `turnwire stop SESSION_ID` | Cancel the current Agent turn |
| `turnwire approvals` | List pending approvals |
| `turnwire approve APPROVAL_ID` / `turnwire reject APPROVAL_ID` | One-time approval |
| `turnwire inbox` / `turnwire inbox --all` | Pending-approval inbox; `--all` also includes handled and expired records |
| `turnwire result REQUEST_ID` | Check whether a request with an uncertain result was eventually submitted |
| `turnwire notifications status` / `on` / `off` | View or toggle the host's Web Push delivery |
| `turnwire devices pair --name my-phone` | Generate a pairing code for a remote device |
| `turnwire devices list` / `turnwire devices revoke DEVICE_ID` | View or revoke devices |
| `turnwire devices upgrade DEVICE_ID --qr` | Replace an existing pairing with a one-time v2 enrollment QR code |
| `turnwire connect` | View this machine's connection information |
| `turnwire connection` | Test the actual round trip to the Mac; remote pairing works the same way |
| `turnwire devices list --watch` | See whether paired devices have confirmed connectivity, plus the last confirmation time and latency |
| `turnwire tui` | Enter the interactive terminal that reuses CLI commands |
| `turnwire remote` | Interactive remote setup, including mode selection, pairing and revocation |
| `turnwire remote status --watch` | Continuously view connection progress; Ctrl+C exits the view |
| `turnwire deploy` / `turnwire deploy --config private-config.json` | Deploy or update the Relay from a form or with one command, automatically configuring HTTPS and a persistent service |
| `turnwire deploy --status` | View deployment progress shared by all local clients |
| `turnwire devices pair --qr` | Show the phone pairing QR code in the terminal |
| `turnwire devices pair --qr-file phone.png` | Save a PNG QR code with mode 0600, without overwriting an existing file |

`--json` outputs structured data, `--url` / `--token` override the local connection, `--pairing FILE` uses a remote pairing code from a file, and `--lang en|zh` forces the interface language instead of detecting it from the environment. Ctrl+C in `attach` only disconnects the client; `stop` is what stops the Agent. Exiting a client does not shut down the daemon or DSH.

## Two ways to send a message

When you send another message while a session is running, the host gives you two semantics:

- **Queued (default)**: waits for the current turn to end and then runs as the next instruction, without interrupting the Agent. The message is marked "queued".
- **Steering**: goes directly into the running turn, to correct direction midway. The message is marked "steering".

Only `turnwire stop` cancels a turn; it does not inject text. The same goes for model selection: the runtime's model catalog is always authoritative (see [Capability parity and code ownership](CLIENTS.md)).
