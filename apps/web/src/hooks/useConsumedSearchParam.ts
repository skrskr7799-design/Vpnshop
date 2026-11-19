import { useEffect, useState } from "react";

// Читает параметр адресной строки один раз и сразу убирает его из URL,
// чтобы сообщение не появлялось повторно после обновления страницы.
export function useConsumedSearchParam(name: string): string | null {
  const [value] = useState(() => new URLSearchParams(window.location.search).get(name));

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(name)) return;
    url.searchParams.delete(name);
    window.history.replaceState(window.history.state, "", url);
  }, [name]);

  return value;
}
