import { useEffect, useState } from "react";

// Читает параметр адресной строки один раз и сразу убирает его из URL,
// чтобы сообщение не появлялось повторно после обновления страницы.
export function useConsumedSearchParam(name: string): string | null {
  const [value] = useState(() => new URLSearchParams(window.location.search).get(name) ??
    (name === "token" ? new URLSearchParams(window.location.hash.slice(1)).get(name) : null));

  useEffect(() => {
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    if (!url.searchParams.has(name) && !(name === "token" && hash.has(name))) return;
    if (name === "token" && hash.has(name)) {
      hash.delete(name);
      url.hash = hash.toString();
    }
    url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", url);
  }, [name]);

  return value;
}
