# Allowed customization

Anything not listed here is a violation. When unsure, park it and ask rather than assuming it is fine.

## Layout classes — always allowed, on any component

These affect position and size only, never appearance:

- spacing: `m-*` `mx-*` `my-*` `mt-*` `mr-*` `mb-*` `ml-*` `p-*` `px-*` `py-*` `pt-*` `pr-*` `pb-*` `pl-*` `gap-*` `space-x-*` `space-y-*`
- box size: `w-*` `min-w-*` `max-w-*` `h-*` `min-h-*` `max-h-*` `size-*` `aspect-*`
- flex / grid: `flex` `inline-flex` `flex-*` `grid` `grid-cols-*` `grid-rows-*` `col-*` `row-*` `items-*` `justify-*` `self-*` `place-*` `order-*`
- position: `relative` `absolute` `fixed` `sticky` `inset-*` `top-*` `right-*` `bottom-*` `left-*` `z-*`
- flow: `block` `inline` `hidden` `overflow-*` `shrink-*` `grow-*` `basis-*` `truncate` `whitespace-*` `break-*`
- text layout (not color or size): `text-left` `text-center` `text-right` `text-justify` `text-wrap` `text-nowrap` `text-balance` `text-pretty`
- responsive and state prefixes on any of the above: `sm:` `md:` `lg:` `xl:` `2xl:` `hover:` `focus:` `data-[...]:`

## Props — allowed

- `variant` and `size`, limited to the values the component's own type union declares. Inventing a value the union doesn't contain is a violation, not a customization.
- behavioral / a11y props the component declares: `disabled`, `type`, `asChild`, `open`, `onOpenChange`, `value`, `onValueChange`, `aria-*`, `id`, `name`, `placeholder`, `required`
- event handlers

## Appearance — not allowed on a design-system component

No exceptions, tokens included:

- `bg-*` `text-<color>` `text-<size>` `border-*` `divide-*` `ring-*` `ring-offset-*` `shadow-*` `rounded-*` `font-*` `tracking-*` `leading-*` `opacity-*`
- **semantic tokens are not an exception.** `bg-card` `bg-muted` `bg-primary` `text-foreground` `text-muted-foreground` `border-border` on a design-system component are violations exactly like `bg-gray-100` is.

The reason is component authority rather than theme-safety. A token keeps the color themeable but still moves the decision to the call site, so the system stops owning what its own components look like. The correct response to a missing appearance is a new variant on the component, proposed to the user — not a class at the point of use.

The project's tokens file (e.g. `tokens.css`) still governs plain elements — a raw `<div>` reaching for a color should use a token from it over a hardcoded value. This section is only about elements imported from an approved component directory.

## Never allowed, anywhere

- raw values: `#hex`, `rgb()`, `hsl()`, `text-[...]`, `bg-[...]`, arbitrary values for color / font / radius / shadow
- Tailwind default-palette colors: `bg-white` `bg-black` `text-white` `text-black` `bg-gray-100` `text-slate-500`
- `style={{ ... }}` for anything other than a computed dimension or transform — a calculated `height` is fine, a hardcoded `color` is not
- `!important` / `!`-prefixed utilities
- spreading unvalidated props (`{...rest}`) onto a design-system component, which smuggles `className` and `style` past every rule above
- typography utilities on semantic elements the base layer already styles (see violation 4 in SKILL.md)

## The one legitimate escape

A component *designed* to be an unstyled layout or slot primitive may accept surface classes, because that is its purpose. This is declared in the component itself — a comment on the same lines as its `@approved` marker saying it is unstyled by design — never assumed at a call site and never added to this file as a color allowlist.

## Adding a legitimate exception

If a customization should be permanently allowed, add it to this file in the same task, so the next run does not re-flag it. An exception is either written down and reusable, or it gets flagged again — no verbal one-off approvals the next session can't see.
