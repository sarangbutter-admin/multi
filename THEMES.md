# Making a theme

A theme decides how a store's shop looks: the layout of the home page, the product cards, colours, fonts and pictures.
The cart, checkout, quick view, product details and order pages are shared by every theme (like checkout on other platforms),
so payments always work the same way. Themes can restyle those parts with CSS.

The quickest start: in the back office open **Look → Theme library**, press **Download** on Market or Classic, change the files,
zip the folder and press **Upload a theme**. Uploading a theme with the same name again replaces it.

## Files

```
my-theme/
  theme.json             name, version, author, description, settings
  theme.css              styles (optional)
  templates/layout.html  the shop page (required)
  templates/card.html    one product card (required)
  assets/                images: png, jpg, webp, gif, svg (max 400 KB each, 1.5 MB in total)
  assets/preview.jpg     picture shown in the theme library (optional; png/jpg/webp/svg)
  README.md              optional
```

The whole .zip may be up to 3 MB.

## theme.json

```json
{
  "name": "Sunny",
  "version": "1.0.0",
  "author": "Your name",
  "description": "One sentence for the theme library.",
  "settings": [
    { "type": "header", "label": "Colours" },
    { "id": "primary", "type": "color", "label": "Main colour", "default": "#146C43" },
    { "id": "hero_title", "type": "text", "label": "Headline", "default": "Hello" },
    { "id": "hero_image", "type": "image", "label": "Banner picture", "default": "asset:hero.png" },
    { "id": "columns", "type": "select", "label": "Cards per row", "options": [{ "value": "3", "label": "Three" }, { "value": "4", "label": "Four" }], "default": "4" },
    { "id": "rounded", "type": "range", "label": "Roundness", "min": 0, "max": 24, "step": 1, "default": 12 },
    { "id": "show_promo", "type": "checkbox", "label": "Show the promo band", "default": true }
  ]
}
```

Setting types: `header` (a group title), `color`, `text`, `textarea`, `image` (an https link or `asset:file.png`), `select`, `range`, `checkbox`, `font`.
Ids use lowercase letters, numbers and `_`. The store owner edits these in **Look**, with a live preview.

Every theme also gets these settings, unless it defines them itself: `primary`, `accent`, `background`, `surface`, `text`, `font`, `radius`, `logo`.
They become CSS variables on the page:

| Variable | What it is |
|---|---|
| `--primary`, `--on-primary` | main colour and readable text on it |
| `--accent`, `--on-accent` | highlight colour and readable text on it |
| `--pop`, `--on-pop` | main colour, or a readable stand-in when the main colour is too dark/light for the cards |
| `--bg`, `--surface`, `--ink`, `--muted`, `--line`, `--soft` | background, cards, text, quiet text, borders, tinted fill |
| `--radius`, `--font` | corner roundness and font family |

## Templates

Templates are HTML with a few tags. Every value is escaped, so text from the store can never break the page.

| Tag | Meaning |
|---|---|
| `{{name}}`, `{{store.name}}` | a value |
| `{{#list}}…{{/list}}` | repeat for each item; or show when the value is true / not empty |
| `{{^list}}…{{/list}}` | show when empty or false |
| `{{> card}}` | the product card (layout only) |
| `{{! note }}` | comment |

### What layout.html can use

| Value | |
|---|---|
| `store.name`, `store.about`, `store.initial`, `store.logo`, `store.whatsapp`, `store.slug` | the store |
| `settings.<id>` | every setting (image settings are ready-to-use links) |
| `categories` | list of `{ name, count, count_label, image, initial }` |
| `has_categories` | true when there are two or more categories |
| `sections` | products grouped by category: `{ name, title, count, products }` |
| `products`, `product_count` | every product (same fields as a card) |
| `cart.count`, `cart.total` | the order so far (kept up to date through `data-bind`, below) |
| `can_switch` | true in the shared app, where customers can switch store |
| `year` | the current year |

### What card.html can use

`id`, `name`, `description`, `image`, `initial`, `category`, `price` (formatted, lowest option), `from` (true when options have different prices),
`sold_out`, `low` (5 or fewer left), `left`, `in_cart` (how many are in the order), `badge` ("Sold out" / "Only 3 left"),
`rating` (`avg`, `count`, `stars`), `variants` (`id`, `name`, `price`, `sold_out`). Everything from the layout is also available.

The card's outer element must have `data-card="{{id}}"`, so the app can refresh it when the order changes.

### Making things work: data attributes

Themes have no JavaScript. Put these attributes on buttons and the app does the rest:

| Attribute | What happens |
|---|---|
| `data-action="product" data-id="{{id}}"` | opens the product's details and reviews |
| `data-action="quickview" data-id="{{id}}"` | opens quick view (photo, options, quantity, add) |
| `data-action="add" data-id="{{id}}"` | adds one; products with options open quick view instead |
| `data-action="cart"` | opens the order and checkout |
| `data-action="orders"` | opens "My orders" and the business login |
| `data-action="stores"` | back to the store list (shared app) |
| `data-action="category" data-category="{{name}}"` | shows one category |
| `data-action="all"` / `data-action="home"` | clears search and filters (`home` also scrolls to the top) |
| `data-action="scroll" data-target="some-id"` | scrolls to the element with that id |
| `<input type="search" data-action="search">` | live search |
| `data-bind="cart-count"`, `data-bind="cart-total"`, `data-bind="results-title"` | text kept up to date |
| `data-home` | hidden while searching or filtering |
| `data-results` + `data-slot="results"` | shown while searching or filtering; the matching cards go in the slot |
| `data-section="{{name}}"` | a category's block (used for scrolling when there's no results area) |

The page also sets `data-cart="empty"` or `"full"` and `data-theme="<theme>"` on `<body>` for styling.

## What a theme can't do

Uploads are checked and refused, with the reason, if they contain any of these:

- `<script>`, `on…=` attributes, `javascript:` links, `<iframe>`, `<form>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<style>` tags (use theme.css)
- `@import` or images from other websites in theme.css (use `url(asset:name.png)` for the theme's own images)
- SVG images with scripts or links
- other files than the ones listed above

The browser also removes anything unsafe from the rendered page. This keeps customers' orders, logins and payments safe whichever theme a store uses.

## Sharing in the theme store

In **Look → Theme library**, press **Share in the theme store** on your upload. The platform admin previews it and approves it,
or turns it down with a note. Approved themes appear in every store's library. Uploading a new version sends it back for review;
stores already using it keep working. Deleting a theme moves every store that used it back to Market.

## Built-in themes

Built-in themes live in `themes/`. After changing them, run `npm run themes` to rebuild `lib/builtin-themes.mjs`
(the tests fail if you forget).
