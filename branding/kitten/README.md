# App icon

`seedream-edit-b.png` is the current app icon source, made by `branding/generate-seedream.ts` (Seedream 5.0 Pro via the OpenRouter Images API) from `bytedance-seed__seedream-5-0-pro.png`, the first pass made by `branding/generate-kitten.ts`.

To rebuild the icon set: mask the white border to transparency, scale the squircle to 824 px centred on a 1024 px canvas as `branding/icon-1024.png`, then run `bunx tauri icon branding/icon-1024.png -o src-tauri/icons` and delete the generated `android/` and `ios/` folders.
