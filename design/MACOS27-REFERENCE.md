# macOS 27 Golden Gate — Design Reference Tokens

Extracted from Apple HIG, WWDC25/26 sessions, macOS 27 beta analysis, and user-provided reference images (`docs/MacOS 27/`).

---

## 1. Typography

Font stack: `-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif`

| Style | Size (pt/px) | Weight | Tracking | Line-height |
|---|---|---|---|---|
| Large Title | 26pt | Bold | -0.8px | ~32pt |
| Title 1 | 22pt | Bold | -0.7px | ~28pt |
| Title 2 | 17pt | Bold | -0.43px | ~22pt |
| Title 3 | 15pt | Semibold | 0px | ~19pt |
| Headline | 13pt | Semibold | +0.03px | ~16pt |
| Body | 13pt | Regular | +0.03px | ~16pt |
| Callout | 12pt | Regular | +0.12px | ~15pt |
| Caption 1 | 11pt | Regular | +0.15px | ~14pt |
| Caption 2 | 10pt | Regular | +0.2px | ~12pt |

**Key rule**: macOS UI body text is 13px, NOT 14-16px. This single difference separates "native" from "web app" feel. Titles can go larger, but all labels, table cells, button text, and controls use 13px or below.

Source: Apple HIG Typography, WWDC20 "Details of UI typography", Figma community file measurements.

---

## 2. Color System

Apple uses semantic tokens, not fixed hex values. Colors adapt across light/dark. The accent color is configurable in System Settings (Blue is default). Docke uses **Teal #0B8578** as accent.

### System Grays (approximated from Figma community file)

| Token | Light | Dark |
|---|---|---|
| Window background | `#ECECEC` | `#1E1E1E` |
| Content background | `#FFFFFF` | `#282828` |
| Grouped background | `#F2F2F7` | `#1C1C1E` |
| Separator | `rgba(0,0,0,0.12)` | `rgba(255,255,255,0.12)` |
| Label (primary) | `#000000` (84% opacity) | `#FFFFFF` (84% opacity) |
| Label (secondary) | `rgba(0,0,0,0.50)` | `rgba(255,255,255,0.55)` |
| Label (tertiary) | `rgba(0,0,0,0.26)` | `rgba(255,255,255,0.25)` |
| Label (quaternary) | `rgba(0,0,0,0.10)` | `rgba(255,255,255,0.10)` |

Source: Apple Design Resources Figma, reference images 160141/160330/160356/160424/160448.

### Accent Colors (from reference images 160330/160356)

System accents: Red, Orange, Yellow, Green, Mint, Teal, Cyan, Blue, Indigo, Purple, Pink, Brown, Gray.
Each has standard + vibrant variant for light and dark backgrounds.

---

## 3. Liquid Glass Materials

### Material Thickness Scale (from reference image 160643/160705/161015)

| Level | Opacity | Blur | Use case |
|---|---|---|---|
| Ultra Thin | Very low | ~8px | Over rich content, subtle background |
| Thin | Low | ~12px | Popover backgrounds |
| Medium (Regular) | Medium | ~20px | Default panels, sidebars |
| Thick | High | ~28px | Toolbars, navigation |
| Ultra Thick | Very high | ~32px | Active window chrome |

### CSS Implementation (consolidated from multiple sources)

**Light mode glass panel:**
```css
background: rgba(255, 255, 255, 0.72);
backdrop-filter: blur(20px) saturate(180%);
border: 1px solid rgba(255, 255, 255, 0.25);
box-shadow:
  inset 0 0.5px 0 rgba(255, 255, 255, 0.8),   /* top specular highlight */
  inset 0 -0.5px 0 rgba(0, 0, 0, 0.05),        /* bottom edge shadow */
  0 8px 32px rgba(0, 0, 0, 0.08);               /* outer drop shadow */
```

**Dark mode glass panel:**
```css
background: rgba(38, 38, 40, 0.72);
backdrop-filter: blur(20px) saturate(180%);
border: 1px solid rgba(255, 255, 255, 0.10);
box-shadow:
  inset 0 0.5px 0 rgba(255, 255, 255, 0.15),
  inset 0 -0.5px 0 rgba(0, 0, 0, 0.3),
  0 8px 32px rgba(0, 0, 0, 0.45);
```

**Four elements that MUST all be present (per ref image 161126):**
1. `backdrop-filter: blur() saturate()` — the refraction
2. Semi-transparent tint background — the color shift
3. Inset border highlight (top bright, bottom dark) — the specular edge
4. Soft outer drop shadow — the depth

Missing any of these four reads as "flat translucent panel", not "glass".

Source: Apple "Materials" documentation, WWDC25 "Meet Liquid Glass", CSS recreations from dev.to/kevinbism and lucky.graphics.

---

## 4. Corner Radii

macOS 27 uses **continuous (superellipse) corners**, not standard CSS `border-radius`. The visual effect is smoother curves. Approximated with larger radii:

| Element | Radius (macOS) | CSS approximation |
|---|---|---|
| Window (with toolbar) | ~14-16px | `border-radius: 16px` |
| Window (titlebar only) | ~10px | `border-radius: 10px` |
| Panels/cards | ~12px | `border-radius: 12px` |
| Dialogs/alerts | ~14px | `border-radius: 14px` |
| Popovers/dropdowns | ~10px | `border-radius: 10px` |
| Buttons (push style) | ~6px | `border-radius: 6px` |
| Buttons (capsule/pill) | 50% height | `border-radius: 9999px` |
| Text fields | ~6px | `border-radius: 6px` |
| Toggle switches | pill | `border-radius: 9999px` |
| Checkboxes | ~4px | `border-radius: 4px` |

**Critical**: macOS dialogs (ref images 155601/155748/155848) use ~14px radius, NOT the 20px we currently have. Alert buttons inside dialogs are NOT pill-shaped — they use moderate ~6-8px radius. Only standalone action buttons or toolbar items are pill-shaped.

Source: Reference images analysis (155424/155454/155601/155630/155713/155748/155848/155911/155931).

---

## 5. Controls

### Buttons (from reference images 155424/155454/155601/155911/155959)

**Push button (standard):**
- Height: ~22-24px (small), ~28px (regular)
- Padding: 12-16px horizontal
- Font: 13px regular (sentence case, never uppercase)
- Background: light fill with subtle glass, or plain white/dark gray
- Border-radius: ~6px (NOT pill for standard buttons)
- **Primary (blue/teal)**: Solid fill, white text
- **Secondary**: Glass/neutral fill, dark text
- **Destructive**: Red text on neutral background, or solid red fill

**Dialog buttons (from 155601/155748/155848):**
- Two buttons side-by-side: Cancel (neutral/glass) + OK/Action (accent-filled, pill shape)
- Height: ~30px
- The primary button IS pill-shaped in dialogs
- Cancel is NOT pill-shaped, uses ~6px radius

### Toggle/Switch (from 155454/155959)
- Width: ~46px, Height: ~26px
- Track: pill shape, green/teal when on, gray when off
- Thumb: white circle with shadow

### Select/Pop-Up Button (from 155424/155454)
- Uses chevron up/down icon (double chevron ⌃⌄), not single dropdown arrow
- Same height as push buttons (~28px)
- Subtle border, ~6px radius

### Checkboxes (from 155454)
- Small rounded squares (~4px radius)
- Blue/accent fill when checked with white checkmark
- Gray border when unchecked

Source: Reference images (control sheets light/dark).

---

## 6. Sidebar (from reference images 155630/155713/155931/160019)

- **Edge-to-edge** in macOS 27 (not inset/floating like Tahoe — key Golden Gate change)
- Slightly translucent background (glass material, "thick" level)
- Items: 13px text, colored icons (SF Symbols), no indent for top-level
- Section headers: 11px, uppercase/small-caps, tertiary color, with letter-spacing
- Selected item: accent-colored pill background, white or accent text
- Separator between sections: thin line, quaternary opacity
- Width: ~200-220px typical

Source: Reference images, 9to5Mac "Golden Gate changes Tahoe critics will appreciate".

---

## 7. Toolbar / Window Chrome (from reference images 6.jpg/7.jpg/155424/155630)

- **Unified toolbar** spanning full window width
- Glass material (thick level)
- Traffic lights (close/minimize/zoom) in top-left
- Title centered or left-aligned after traffic lights
- Subtitle in secondary text below title
- **Grouped controls**: related toolbar icons grouped in pill-shaped containers (ref image 7.jpg — reply/forward grouped, archive/delete/junk grouped)
- Individual toolbar controls: ~28-32px touch target, icon-only with tooltip
- **Search field**: capsule-shaped, magnifying glass icon, right-aligned in toolbar

Source: Reference images (Mail toolbar, TextEdit toolbar, Finder toolbar).

---

## 8. Dialogs/Alerts (from reference images 155340/155601/155748/155848/155911)

- **Light mode**: white/light gray background, subtle shadow, ~14px radius
- **Dark mode**: dark gray background (#2A2A2C), subtle glass material, ~14px radius
- Title: 13px bold (or 15px semibold for important alerts)
- Description: 13px regular, secondary color
- Input fields: standard text field style, blue/teal focus ring
- **Button layout**: Cancel left, Primary right. Cancel uses glass/neutral style, Primary uses solid accent fill
- Compact padding: 16-20px internal padding
- No close (X) button — uses Cancel

Source: Reference images analysis.

---

## 9. Lists/Tables (from reference images 155630/155713/155931/160019)

- **No visible borders between cells** — separation by alternating background or spacing only
- Selected row: accent-colored full-width highlight (systemBlue or accent)
- Column headers: 11-12px, secondary color, with sort indicator (chevron)
- Row height: ~24-28px for dense lists
- Alternating rows: very subtle (2-3% opacity difference), or none
- File/folder icons: small colored thumbnails/icons, not monochrome
- Group headers: Small caps or semibold, with disclosure triangle

Source: Reference images (Finder list views light/dark).

---

## 10. Motion / Animation

| Type | Duration | Easing |
|---|---|---|
| Hover state | 100-150ms | ease-out |
| Button press | 80ms | ease-in |
| Panel open | 200-250ms | cubic-bezier(0.2, 0.8, 0.2, 1) — spring-like |
| Modal appear | 250ms | cubic-bezier(0.2, 0.8, 0.2, 1) |
| Page transition | 200ms | ease-out |
| Tooltip appear | 400ms delay, 150ms fade | ease |

**macOS hover behavior**: Very subtle. No scale transforms, no glow effects. Just a slight background tint change. The hover on toolbar buttons shows a very faint glass highlight, not a dramatic visual change.

Source: WWDC25 "Meet Liquid Glass", general macOS observation.

---

## 11. Shadows

| Level | Value |
|---|---|
| Window (active) | `0 10px 40px rgba(0,0,0,0.20), 0 2px 8px rgba(0,0,0,0.08)` |
| Window (inactive) | `0 4px 16px rgba(0,0,0,0.10), 0 1px 4px rgba(0,0,0,0.05)` |
| Popover/menu | `0 8px 30px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.06)` |
| Card (elevated) | `0 1px 3px rgba(0,0,0,0.06)` |
| Dark mode shadows | ~1.5-2x stronger alpha values |

Source: General macOS observation, CSS Liquid Glass guides.

---

## 12. Scrollbars

- **Overlay scrollbars** (not permanent track)
- Appear only during active scroll
- Thin (~7px width), rounded caps
- Semi-transparent gray (adapts to content)
- Fade out ~1.5s after scroll stops

Source: macOS system behavior.

---

## 13. Focus Rings

- 3px solid accent color ring
- 2px offset from element edge
- Visible only on keyboard navigation (`:focus-visible`)
- Rounded to match element shape

Source: Apple HIG "Focus and selection".

---

## 14. Dark Mode Specifics

macOS dark mode is NOT "invert everything". It uses its own distinct material system:

- **Window background**: `#1E1E1E` to `#282828` (NOT pure black)
- **Glass panels**: Dark tint with higher blur, brighter specular rim
- **Text**: White at 84% opacity for primary, 55% for secondary
- **Separators**: White at 12% opacity (NOT gray borders)
- **Accent colors**: Slightly lighter/brighter variants than light mode
- **Shadows**: Stronger (higher alpha), but same structure

Source: Reference images (all dark variants), Apple HIG "Dark Mode".
