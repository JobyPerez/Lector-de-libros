import { useQuery } from "@tanstack/react-query";

import { fetchAwsCostMonthToDate, type ApiRequestError, type AwsCostMonthToDate } from "../app/api";

type AwsCostBadgeProps = {
  accessToken: string | null | undefined;
  hasAwsCredentials?: boolean;
};

function extractErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "No se pudo consultar el gasto de AWS.";
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("es-ES", {
      currency,
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
      style: "currency"
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatFetchedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit"
    });
  } catch {
    return iso;
  }
}

export function AwsCostBadge({ accessToken, hasAwsCredentials }: AwsCostBadgeProps) {
  const query = useQuery<AwsCostMonthToDate>({
    enabled: Boolean(accessToken) && hasAwsCredentials !== false,
    queryFn: ({ signal }) => fetchAwsCostMonthToDate(accessToken as string),
    queryKey: ["aws-cost-month-to-date"],
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60 * 60 * 1000
  });

  if (hasAwsCredentials === false) {
    return null;
  }

  if (query.isLoading) {
    return <span className="aws-cost-badge aws-cost-badge-loading">Gasto mes: cargando…</span>;
  }

  if (query.isError) {
    const errorStatus = (query.error as ApiRequestError | null)?.statusCode;
    const message = extractErrorMessage(query.error);

    return (
      <span className="aws-cost-badge aws-cost-badge-error" title={`${message}${errorStatus ? ` (HTTP ${errorStatus})` : ""}`}>
        Gasto mes: no disponible{errorStatus ? ` (${errorStatus})` : ""}
      </span>
    );
  }

  if (!query.data) {
    return null;
  }

  const { total, currency, fetchedAt, services } = query.data;
  const title = services.length
    ? `${services.map((s) => `${s.service}: ${formatAmount(s.amount, currency)}`).join("\n")}\nActualizado: ${formatFetchedAt(fetchedAt)}`
    : `Actualizado: ${formatFetchedAt(fetchedAt)}`;

  return (
    <span className="aws-cost-badge" title={title}>
      Gasto mes: <strong>{formatAmount(total, currency)}</strong>
    </span>
  );
}