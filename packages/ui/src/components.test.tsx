import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, FormField, Input, Labyrinth, StatusIndicator, statusTone } from "./index";

describe("MZT UI semantics", () => {
  it("renders a pending native button with its original accessible name", () => {
    const html = renderToStaticMarkup(<Button loading>Создать заказ</Button>);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Создать заказ");
  });

  it("associates the control with a label and its announced validation error", () => {
    const html = renderToStaticMarkup(<FormField label="Почта" error="Проверьте адрес">
      {props => <Input {...props} type="email" />}
    </FormField>);
    const [, id] = html.match(/<label for="([^"]+)"/) ?? [];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-describedby="${id}-note"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
  });

  it.each([["READY", "success"], ["STALE", "warning"], ["HELD", "danger"], ["WAITING_EXTERNAL", "info"],
    ["NOT_REQUESTED", "neutral"]])("keeps %s distinct", (status, tone) => {
    expect(statusTone(status)).toBe(tone);
    expect(renderToStaticMarkup(<StatusIndicator status={status}>Состояние</StatusIndicator>)).toContain("Состояние");
  });

  it("keeps the Labyrinth decorative and self-contained", () => {
    const html = renderToStaticMarkup(<Labyrinth />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("mz-maze-route");
    expect(html).not.toMatch(/<image|href=/);
  });
});
