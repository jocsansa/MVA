// Arquivos da página além do index.html, servidos de public/ com o tipo certo.
// Módulo separado para o teste conferir os caminhos sem subir o servidor.
import { fileURLToPath } from "node:url";

export interface StaticFile { path: string; type: string }

const file = (name: string, type: string): StaticFile =>
  ({ path: fileURLToPath(new URL(`../public/${name}`, import.meta.url)), type });

/** Rota → arquivo em public/ e tipo. */
export const STATIC_FILES: ReadonlyMap<string, StaticFile> = new Map([
  ["/app.css", file("app.css", "text/css")],
  ["/app.js", file("app.js", "text/javascript")],
  ["/eq-curve.js", file("eq-curve.js", "text/javascript")],
]);
