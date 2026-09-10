English · [中文](DESIGN.zh.md)

# Turnwire client design

Turnwire is a developer's session workbench. Its single job is to make the same local task legible and controllable from another device.

Use a cool paper canvas `#f5f6f8`, white surfaces `#ffffff`, blue-grey sidebar `#edf0f5`, ink `#243142`, secondary ink `#647184`, and restrained blue `#2f5ec4`. Display uses Avenir Next on macOS, body uses the platform system face, technical output uses system monospace. Native macOS follows system materials and controls.

Desktop: narrow session sidebar, wide readable conversation, compact device connection bar. Phone: conversation occupies the screen, with a deliberate session drawer. The identifying element is the continuity bar showing the actual connected Mac and selected session; it describes real state. Approvals sit next to the composer with the operation and a one-shot decision. Avoid presenting a settings dashboard as the main interface.

Empty, loading, offline, runtime unavailable and error states explain the next action. No fabricated projects, tasks, metrics or output. The Demo runtime is always labeled. Respect keyboard navigation, focus visibility and reduced motion. Connection secrets are entered in a dedicated connection view and stay in session storage unless the user elects to remember the device.
