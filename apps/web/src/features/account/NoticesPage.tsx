import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Icon, PageHeader } from "@vpn/ui";
import { request } from "../../api/client";
import { date, errorMessage } from "./account";
import { PageList } from "./CommercePages";

type Notice = { id: string; title: string; body: string; createdAt: string; readAt: string | null };

export function NoticesPage() {
  const cache = useQueryClient();
  const read = useMutation({
    mutationFn: (id: string) => request<void>(`/me/notices/${id}/read`, {
      method: "POST", idempotencyKey: crypto.randomUUID(),
    }),
    onSuccess: () => cache.invalidateQueries({ predicate: query => {
      const path = query.queryKey.at(-1);
      return query.queryKey[0] === "owner" && typeof path === "string" && path.startsWith("/me/notices");
    } }),
  });
  return <>
    <PageHeader title="Сервисные сообщения" />
    {read.isError && <p role="alert">{errorMessage(read.error)}</p>}
    <PageList<Notice> path="/me/notices" empty="Сообщений пока нет" render={notice => <>
      <div className="mzt-panel-heading"><h2>{notice.title}</h2><time dateTime={notice.createdAt}>{date(notice.createdAt)}</time></div>
      <p className="mzt-notice-text">{notice.body}</p>
      {!notice.readAt && <Button variant="secondary" disabled={read.isPending}
        loading={read.isPending && read.variables === notice.id} onClick={() => read.mutate(notice.id)}>
        <Icon name="check" size={17} />Отметить прочитанным
      </Button>}
    </>} />
  </>;
}
