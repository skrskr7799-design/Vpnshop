import { Button } from "../Button/Button";
import { Spinner } from "../Spinner/Spinner";
import "./PageStatus.css";

type PageStatusProps = { kind: "loading" } | { kind: "error"; onRetry: () => void };

// Состояние всей страницы: загрузка или недоступный сервис
export function PageStatus(props: PageStatusProps) {
  if (props.kind === "loading") {
    return (
      <div className="page-status" role="status" aria-label="Загрузка">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="page-status page-status--error">
      <p>Не удалось связаться с сервером. Проверьте интернет и повторите.</p>
      <Button block={false} variant="secondary" onClick={props.onRetry}>
        Повторить
      </Button>
    </div>
  );
}
