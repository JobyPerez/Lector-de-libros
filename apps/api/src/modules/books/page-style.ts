import { z } from "zod";

const hex = z.string().regex(/^#[0-9a-f]{6}$/iu).transform((value) => value.toLowerCase());
export const pageStyleSchema = z.object({
  color: hex.optional(), backgroundColor: hex.optional(), borderColor: hex.optional(),
  borderWidth: z.number().finite().min(0).max(8).optional(),
  padding: z.number().finite().min(0).max(48).optional(),
  fontScale: z.number().finite().min(0.5).max(3).optional(),
  fontFamily: z.enum(["serif", "sans-serif"]).optional(),
  alignment: z.enum(["left", "center", "right"]).optional()
}).strict();
export type PageStyle = z.infer<typeof pageStyleSchema>;

export function renderPageStyle(input: PageStyle | undefined): string {
  const style = pageStyleSchema.parse(input ?? {});
  return [style.color && `color:${style.color}`, style.backgroundColor && `background-color:${style.backgroundColor}`,
    style.borderColor && `border-color:${style.borderColor}`,
    style.borderWidth !== undefined && `border-width:${style.borderWidth}px;border-style:solid`,
    style.padding !== undefined && `padding:${style.padding}px`,
    style.fontScale !== undefined && `--reader-font-scale:${style.fontScale};font-size:${style.fontScale}em`,
    style.fontFamily && `font-family:${style.fontFamily}`, style.alignment && `text-align:${style.alignment}`
  ].filter((value) => typeof value === "string").join(";");
}

// Parse complete declarations only; never copy source CSS into generated HTML.
export function parsePageStyle(css: string): PageStyle | undefined {
  const result: PageStyle = {};
  const properties = { color: "color", "background-color": "backgroundColor", "border-color": "borderColor",
    "border-width": "borderWidth", padding: "padding", "font-size": "fontScale", "font-family": "fontFamily", "text-align": "alignment" } as const;
  for (const declaration of css.split(";")) {
    const match = declaration.trim().match(/^([a-z-]+)\s*:\s*([^:;]+)$/iu);
    if (!match) continue;
    const key = properties[match[1]!.toLowerCase() as keyof typeof properties];
    if (!key) continue;
    const value = match[2]!.trim().toLowerCase();
    const unit = key === "fontScale" ? "em" : key === "padding" || key === "borderWidth" ? "px" : null;
    if (unit && !new RegExp(`^(?:\\d+(?:\\.\\d+)?|\\.\\d+)${unit}$`, "u").test(value)) continue;
    const candidate = { [key]: unit ? Number(value.slice(0, -unit.length)) : value };
    const parsed = pageStyleSchema.safeParse(candidate);
    if (parsed.success) Object.assign(result, parsed.data);
  }
  return Object.keys(result).length ? result : undefined;
}
