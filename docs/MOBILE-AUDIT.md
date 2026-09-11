English · [中文](MOBILE-AUDIT.zh.md)

# Mobile presentation audit

## Scope and evidence

Turnwire PWA audit: 320/360/390/430px portrait widths; 320/400px short heights and 640×320, 844×390 landscape. Chrome headless measurements are not physical Safari/Android keyboard tests. Runtime model tests use an isolated DSH catalog: presentation stress changes visible label text only, never model IDs or selectable catalog entries. No production session was mutated for the audit.

## Confirmed problems addressed

| Problem | Change | Verification |
| --- | --- | --- |
| Running toolbar with approval + model + Stop + Send pushed Send out of narrow viewports | Shrink model label within available space; pin Stop/Send, compact mobile Stop, reserve path budget; no extra approval row | `ui-model-check.sh`: isolated DSH catalog, 320/360/390/430px presentation stress, full control bounds/minimum dimensions |
| Fixed footer and stacked approvals could consume the entire conversation or extend offscreen at short heights | Bounded, shrinkable scrollable footer; minimum transcript height; short-height banner budget | `question-ui-check.mjs`: real isolated Relay/PWA with 12 approvals and 32 children; footer/conversation bounds, Send and approval scroll reachability at six short/landscape sizes |
| Waiting status/actions squeezed header title to roughly 1px at 320px | Mobile status dot retains DOM text and title; title minimum width, wrap fallback | `mobile-content-ui-check.mjs`: actual stylesheet fixture, title ~82px at320, full header bounds |
| Unbroken title/directory components widened content | Bounded heading wrappers with anywhere wrapping | Source stylesheet geometry fixture with long content |
| Tool/agent disclosures measured 15–18px high | Mobile disclosure minimum32px; agent/header/child actions36px | Source stylesheet geometry fixture and disclosure activation |
| Small editable inputs risk iOS focus zoom | Mobile question/queue/filter/rename inputs16px | Computed CSS; physical iOS behavior unverified |
| Child action labels could crowd narrow readers | Wrapping action row and bounded text | Source stylesheet geometry fixture |
| Child polling added/removes loading paragraph every2s; older page retained old scroll offset | Initial/manual loads show loading, background polling does not; older navigation resets top | Existing child reader lifecycle browser regression; exact coordinate/tail-follow policy still needs stronger coverage |
| Markdown regression used obsolete connected banner selector | Assert current connected button | Existing encrypted replay/Markdown browser scenario |

Other regressions: directory creation validation/cancel/error/busy/confirmation, child inline launch identity/retention/reload, chronological history and Markdown wrapping/independent code/table scrolling.

## Remaining risks and follow-up work

- **Physical devices:** iOS Safari and installed PWA keyboard, visualViewport pan/resize, safe-area insets, browser chrome, text-size scaling, VoiceOver/TalkBack and actual touch accuracy were not tested. 32–36px compact targets improve the 15–18px baseline but do not meet the preferred44px target everywhere.
- **Very short screens:** footer content may require scrolling to reach Send or an approval; it is intentionally not hidden. Above-only model picker positioning may collapse in extreme visualViewport conditions; model browser tests cover ordinary narrow/short geometry, not real keyboard occlusion.
- **Directory chooser:** deep path can take substantial vertical space next to Home/Up. Dialog remains scrollable; no confirmed unreachable control. A separately expandable path display would reduce clutter.
- **Focus/accessibility:** closing the final inactive child detail, submitting question controls, or ending queue edit may remove the focused element without an intentional next target. Drawer main-content virtual-navigation isolation and broad live status regions need assistive-technology validation.
- **Scroll policy:** parent bottom-follow under viewport/footer resizing and child live replacement anchoring need record-ID/pixel-coordinate tests. Existing functional tests are not proof of perfect scroll anchoring.
- **Separate correctness issue:** queue refresh is not session-generation-scoped like child catalog reads; a delayed old-session response can overwrite queue state. Queue editing Enter also lacks question input's IME guard. These are recorded rather than bundled into a visual patch without dedicated behavioral tests.
- **Native:** this audit concerns the PWA. No macOS/Swift validation was performed, and no native capability contract changes were required.

## Running checks

Build first (`npm run check`) before scripts that serve the production PWA. Run `bash scripts/ui-model-check.sh` for isolated DSH model controls. Other scenarios use `node --import tsx scripts/<name>.mjs`; `mobile-content-ui-check.mjs` is a source-CSS fixture and can run with plain Node. Source fixtures cannot alone certify actual runtime composition, so keep both runtime-backed and fixture checks.
