# Gap Audit: Docke (current) vs macOS 27 Golden Gate

Status: Initial audit based on codebase review + 42 reference images.

---

## CRITICAL (these are what make it "not feel like macOS")

### G01. No dynamic wallpaper behind glass — glass has nothing to refract
- **Current**: `--bg-page: #F8F9FA` (light) / `#111111` (dark) — flat solid color
- **macOS 27**: Every reference image shows glass floating over a colorful, blurred desktop wallpaper. The glass materials only work visually because there's color variation behind them to refract.
- **Fix**: Add a fixed, subtle multi-color gradient background (using brand-appropriate tones). This is the single biggest reason the app doesn't "feel" like macOS — `backdrop-filter` over a solid color produces no visual effect.
- **Files**: `tokens.css`, `AppShell.tsx`

### G02. Typography scale is web-scale, not macOS-scale
- **Current**: Body text is 14px (`text-sm` in Tailwind), labels are 12px (`text-xs`), page titles are 20-24px. Widespread use of `text-sm` (14px) for table cells, sidebar items, buttons.
- **macOS 27**: Body text is **13px**, button labels are 13px, table cells are 13px, captions are 11px. Page titles max at 22px (Title 1). No UI text at 16px unless it's a featured headline.
- **Fix**: Create a macOS typography scale: replace `text-sm` (14px) with 13px for all UI text, `text-xs` (12px) stays for captions, titles use 22px/17px/15px. This single change shifts the density from "web app" to "native app".
- **Files**: Every page and component file. Global approach: custom Tailwind fontSize config or utility classes.

### G03. Font stack doesn't attempt system font
- **Current**: `font-sans: ['Inter', ...]` in Tailwind config
- **macOS 27**: Uses SF Pro via `-apple-system, BlinkMacSystemFont`. On Mac, this renders as SF Pro (the actual macOS system font). On Windows/Linux, it falls back to Segoe UI / system font.
- **Fix**: Change font stack to `'-apple-system', 'BlinkMacSystemFont', 'Inter', 'Segoe UI', sans-serif`. Inter remains the fallback but Mac users get the real system font.
- **Files**: `tailwind.config.ts`

### G04. Buttons use wrong shape for context
- **Current**: ALL buttons are `rounded-full` (pill shape) everywhere
- **macOS 27**: Standard push buttons use ~6px radius. Only certain controls are pill: dialog primary buttons, toggle tracks, capsule search fields, toolbar pill groups. Regular action buttons (Save, Cancel, New Folder, Delete) in dialogs use moderate radius ~6-8px.
- **Fix**: Default button radius to `rounded-md` (~6px). Pill shape only for: primary CTA in dialogs, toggle switches, search input, dock items, toolbar icon groups.
- **Files**: `Button.tsx`, all files using `<Button>`

### G05. Window/panel corner radii too large
- **Current**: Cards use `rounded-[22px]`, modals `rounded-[20px]`, dropdowns `rounded-[14px]`
- **macOS 27**: Windows ~14-16px, panels ~12px, dialogs ~14px, popovers ~10px. The 22px radius reads as "iOS-mobile", not "macOS-desktop".
- **Fix**: `--radius-glass-panel: 12px` (was 22px), modals `14px` (was 20px), popovers/dropdowns `10px` (was 14px).
- **Files**: `tokens.css`, `AppShell.tsx`, all modal/popover components

### G06. Input fields have inconsistent/wrong radius
- **Current**: Inputs use `rounded-[8px]` in ShareModal and similar files. Search bar in TopBar uses `rounded-full`.
- **macOS 27**: Standard inputs use ~6px radius. Search fields are capsule (pill). Selects use ~6px radius.
- **Fix**: Inputs `rounded-md` (6px), search fields `rounded-full`, selects `rounded-md`.
- **Files**: All forms: `ShareModal.tsx`, Settings pages, `UploadModal.tsx`, `TopBar.tsx` search bar

---

## HIGH (noticeable differences from macOS native)

### G07. Hover effects too dramatic
- **Current**: `.glass-interactive` does `translateY(-2px)` on hover. Cards lift 2px.
- **macOS 27**: Hover is extremely subtle — just a slight background tint change (see toolbar buttons in ref images 6.jpg, 7.jpg). No translation, no scale, no glow.
- **Fix**: Remove `translateY(-2px)` from glass-interactive hover. Replace with subtle background opacity change only.
- **Files**: `tokens.css`

### G08. Dialog/Modal buttons layout wrong
- **Current**: Modals have an X close button in the top-right corner. Buttons are pill-shaped.
- **macOS 27**: Alerts have NO X close button (ref images 155601/155748/155848). They use Cancel + Primary button. Cancel is neutral/glass, Primary is accent-filled pill. Layout is two buttons at bottom, side by side.
- **Fix**: Remove X close button from alert/confirm modals (keep it for complex panels like ShareModal). Make Cancel non-pill, Primary pill.
- **Files**: `ConfirmModal.tsx`, `ShareModal.tsx`

### G09. Dark mode background too pure-black
- **Current**: `--bg-page: #111111`, `--bg-card: #1A1A1A`
- **macOS 27**: Window background is `#1E1E1E` to `#282828` (ref images 155911/155931/155959/160019). NOT pure black. The slight warmth/lightness is critical.
- **Fix**: `--bg-page: #1E1E1E`, `--bg-card: #282828`, `--bg-elevated: #323232`
- **Files**: `tokens.css`

### G10. Light mode window background wrong tone
- **Current**: `--bg-page: #F8F9FA` (cool gray-blue tint)
- **macOS 27**: Window background is `#ECECEC` (warm neutral gray, ref images 155424/155630/155713)
- **Fix**: `--bg-page: #ECECEC`, or slightly lighter `#F0F0F0`. The key is it's a neutral gray, not blue-tinted.
- **Files**: `tokens.css`

### G11. Separator/border color wrong approach
- **Current**: `--border-default: #E9ECEF` (light) / `#2A2A2A` (dark) — specific gray values
- **macOS 27**: Separators use alpha-based colors: `rgba(0,0,0,0.12)` light, `rgba(255,255,255,0.12)` dark. This adapts automatically to the content behind.
- **Fix**: Use alpha-based border colors that adapt to glass context.
- **Files**: `tokens.css`

### G12. Text colors use solid values instead of alpha
- **Current**: `--text-primary: #212529` / `#F0F0F0`, `--text-secondary: #5A6268` / `#A8A8A8`
- **macOS 27**: Text uses alpha-based colors: primary `rgba(0,0,0,0.84)` / `rgba(255,255,255,0.84)`, secondary `rgba(0,0,0,0.50)` / `rgba(255,255,255,0.55)`. Alpha-based text adapts when placed on glass materials (vibrant labels).
- **Fix**: Switch to alpha-based text colors for at least secondary/tertiary levels.
- **Files**: `tokens.css`

### G13. Dropdown/popover menus not glass
- **Current**: Company selector dropdown and avatar dropdown use `bg-[var(--bg-card)]` — solid opaque background
- **macOS 27**: Context menus and dropdown menus are glass panels with blur (ref image 155519 — Finder View menu is translucent glass)
- **Fix**: Apply glass material to all popover menus.
- **Files**: `TopBar.tsx` (company dropdown, avatar dropdown)

### G14. Dock items lack grouped-pill containers
- **Current**: Individual items with hover backgrounds
- **macOS 27**: Toolbar/dock actions are grouped into pill-shaped containers (ref image 7.jpg — Mail toolbar groups reply/reply-all/forward into one glass pill, archive/delete/junk into another)
- **Fix**: Group related dock items into glass pill containers with subtle internal separators.
- **Files**: `Dock.tsx`

### G15. Search field not capsule-shaped properly
- **Current**: TopBar search has `rounded-full` but uses `bg-[var(--bg-page)]` with border — looks like a text input, not a macOS search field
- **macOS 27**: Search field is a glass/translucent capsule integrated into the toolbar, not a bordered input sitting on top
- **Fix**: Make search field use glass material background, remove explicit border, use subtle placeholder styling.
- **Files**: `TopBar.tsx`

---

## MEDIUM (polish differences)

### G16. Toolbar buttons should use glass material for hover
- **Current**: Toolbar icon buttons use `hover:bg-[var(--bg-hover)]` — a solid color
- **macOS 27**: Toolbar button hover shows a subtle glass highlight circle (ref images 6.jpg, 7.jpg — each icon in toolbar gets a very faint circular glass highlight on hover)
- **Fix**: Use translucent hover background: `hover:bg-[rgba(0,0,0,0.05)]` light / `hover:bg-[rgba(255,255,255,0.08)]` dark
- **Files**: `TopBar.tsx`, `Dock.tsx`

### G17. Table column headers need macOS styling
- **Current**: Standard text headers
- **macOS 27**: Column headers are 11-12px, secondary color, with disclosure sort triangles (not up/down arrows). Clean separator below header row. (ref images 155630/155713)
- **Fix**: Smaller header text, subtler sort indicators, single bottom separator.
- **Files**: `Documents.tsx`

### G18. Selected row highlight should use accent color
- **Current**: Selection likely uses teal background classes
- **macOS 27**: Selected row gets a solid accent-colored bar across full width (ref images 155713/160019 — deep blue highlight for selected folder)
- **Fix**: Full-width accent highlight on selected rows in file lists.
- **Files**: `Documents.tsx`

### G19. Scrollbar styling
- **Current**: Default browser scrollbars
- **macOS 27**: Overlay scrollbars that appear only during scroll, thin, rounded, semi-transparent
- **Fix**: CSS scrollbar styling: thin, overlay, auto-hide behavior.
- **Files**: `tokens.css` or global styles

### G20. Modal/dialog scaling animation wrong
- **Current**: `modal-in` animation uses `scale(0.95) → scale(1.0)` with `ease` curve
- **macOS 27**: Dialogs use a spring-like appearance (slight overshoot). The easing should be more energetic.
- **Fix**: Use spring-like cubic-bezier: `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- **Files**: `tokens.css`

### G21. Toast notifications style
- **Current**: Custom toast with slide-in
- **macOS 27**: System notifications are glass panels with rounded corners, icon + title + body layout
- **Fix**: Apply glass material to toast, adjust shape.
- **Files**: `Toast.tsx`

### G22. Focus ring color and style
- **Current**: `outline: 2px solid #3FBFA8` (teal)
- **macOS 27**: Focus ring is 3px, accent color, 2px offset, rounded to match element
- **Fix**: Increase to 3px, ensure it follows element border-radius.
- **Files**: `tokens.css`

### G23. Empty states
- **Current**: Custom EmptyState component
- **macOS 27**: macOS empty states are extremely minimal — centered icon + short text, no decorative elements
- **Fix**: Verify EmptyState matches macOS simplicity.
- **Files**: `EmptyState.tsx`

### G24. Section headers in sidebar/lists
- **Current**: Standard bold text
- **macOS 27**: Section headers use 11px, semibold, uppercase or small-caps, with generous top padding (ref images 155630/155713 — "Favorites", "Locations", "Tags" section headers)
- **Fix**: Adopt macOS section header pattern.
- **Files**: Settings pages, any sectioned list

---

## LOW (refinements)

### G25. Transition timing
- **Current**: 180ms with `cubic-bezier(0.4, 0, 0.2, 1)` (Material Design ease)
- **macOS 27**: 150ms with `ease-out` or spring-like curves for most UI interactions
- **Fix**: Adjust global transition to 150ms ease-out.
- **Files**: `tokens.css`

### G26. Glass highlight line positioning
- **Current**: `top: 0; left: 14px; right: 14px` — doesn't reach panel edges
- **macOS 27**: Specular highlight follows the full width of the panel top edge
- **Fix**: Extend highlight to `left: 0; right: 0` with border-radius clipping.
- **Files**: `tokens.css`

### G27. Badge/chip styling
- **Current**: Custom badge with teal background
- **macOS 27**: Tags and badges use very subtle fills, smaller text (10-11px)
- **Fix**: Reduce badge visual weight.
- **Files**: `Badge.tsx`

### G28. Avatar component
- **Current**: Custom circular avatar
- **macOS 27**: Contact circles use a very specific style with initials on gradient
- **Fix**: Minor visual refinement.
- **Files**: `Avatar.tsx`

### G29. Login page not audited
- **Fix**: Apply macOS styling to Login page.
- **Files**: `Login.tsx`

### G30. Onboarding / SessionExpired / PublicShare not audited
- **Fix**: Apply macOS styling to these pages.
- **Files**: `SessionExpiredOverlay.tsx`, `PublicShare.tsx`

---

## Summary: Priority Order for Maximum Impact

1. **G01** — Dynamic wallpaper background (the #1 reason it doesn't feel like macOS)
2. **G02 + G03** — Typography: 13px body + system font stack
3. **G05 + G06** — Corner radii correction (12px panels, 6px inputs, 14px dialogs)
4. **G09 + G10 + G11 + G12** — Color system overhaul (backgrounds, alpha-based borders/text)
5. **G04** — Button shape context correction
6. **G07** — Remove dramatic hover effects
7. **G08** — Dialog button layout
8. **G13** — Glass menus/popovers
9. **G19** — Overlay scrollbars
10. Everything else (G14-G30)
