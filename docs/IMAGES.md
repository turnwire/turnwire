English · [中文](IMAGES.zh.md)

# Image messages

Image transport and model vision are different capabilities. The pinned DSH Host accepts image prompt parts and validates the selected model before admission. Its public model catalog does not expose input modalities. Turnwire therefore does not infer image support from model names or alter model configuration. A transport-capable session may still reject an image for its current route; clients must preserve the draft and show that error.

The installed DeepSeek adapter declares image input for some runtime-owned entries. The checked-in Codex bridge route declares only IDs/names and defaults to text input. Listing that route does not prove the bridge can process images. No live provider recognition accuracy is claimed by interface/transport tests.

## Bounded input

The initial image path accepts up to two PNG/JPEG/WebP/GIF images, at most256KiB decoded per image and512KiB total. Text accompanying images is limited to16,000 characters so JSON and base64 remain within existing transport limits. SVG and arbitrary URLs/host paths are not image inputs. PWA preparation may resize/re-encode a selected photo and tells the user; clients that do not resize must reject oversize data clearly.

`session.message` accepts optional `images` entries `{mediaType,data,name?}`, with canonical base64 data. Empty text is permitted only when images are supplied. Unsupported runtimes reject before sending; the DSH Host validates the exact model and image bytes before queue/steer admission. Images are sent to the selected model service for processing. Choosing an image does not upload it before submission.

## Storage and reads

Turnwire history stores only normalized opaque image references and metadata, never base64 image bodies. DSH owns normalization and durable image storage. `session.image` reads an attachment referenced by the requested Turnwire session, using bounded base64 chunks through the same authenticated local or encrypted remote connection. It is not a public image URL or filesystem read. No provider/DSH credentials are exposed to clients.

Image references remain visible in history and exports as metadata; text export does not embed image bytes. Queue text edits must not silently replace an image-bearing prompt with text-only content. A rejected request must not create a successful-looking local image message.

## Verification boundary

The isolated real DSH browser test verifies that its configured text-only bridge rejects an image before inference and the browser preserves the draft. Local/encrypted-remote transport, reference-only history, scoped image reads and persistence use a deterministic runtime fixture; browser tests cover selection/paste/preparation, removal, failure preservation and previews. Schema, adapter-contract, session-scope, transport and UI tests do not prove that a provider recognized a particular image correctly. Physical mobile photo pickers, actual provider inference and native macOS compilation require explicit verification; report their status separately. Runtime-owned model IDs and catalog entries must never be synthesized for tests.
