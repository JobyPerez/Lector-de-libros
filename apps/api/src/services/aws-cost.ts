import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";

export type AwsCostLineItem = {
  amount: number;
  service: string;
};

export type AwsCostMonthToDate = {
  currency: string;
  fetchedAt: string;
  services: AwsCostLineItem[];
  total: number;
};

export type AwsCostCredentials = {
  accessKeyId: string;
  region: string;
  secretAccessKey: string;
};

const COST_EXPLORER_REGION = "us-east-1";
const CACHE_TTL_MS = 60 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  value: AwsCostMonthToDate;
};

const costCache = new Map<string, CacheEntry>();

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildMonthToDatePeriod(): { Start: string; End: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    Start: formatIsoDate(start),
    End: formatIsoDate(end)
  };
}

function roundAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function getAwsMonthToDateSpend(
  credentials: AwsCostCredentials
): Promise<AwsCostMonthToDate> {
  const cacheKey = `${credentials.accessKeyId}:${credentials.region}`;
  const cached = costCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const client = new CostExplorerClient({
    apiVersion: "2017-10-25",
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    },
    region: COST_EXPLORER_REGION
  });

  let currency = "USD";
  const totalsByService = new Map<string, number>();
  let total = 0;

  let nextToken: string | undefined;
  do {
    const command = new GetCostAndUsageCommand({
      Granularity: "MONTHLY",
      Filter: {
        Dimensions: {
          Key: "RECORD_TYPE",
          Values: ["Usage"]
        }
      },
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
      Metrics: ["UnblendedCost"],
      TimePeriod: buildMonthToDatePeriod(),
      NextPageToken: nextToken
    });

    const response = await client.send(command);

    if (nextToken === undefined && (response.ResultsByTime?.length ?? 0) > 0) {
      const firstTotal = response.ResultsByTime?.[0]?.Total?.UnblendedCost;
      if (firstTotal?.Unit) {
        currency = firstTotal.Unit;
      }
    }

    for (const resultByTime of response.ResultsByTime ?? []) {
      const groups = resultByTime.Groups ?? [];

      for (const group of groups) {
        const serviceName = group.Keys?.[0] ?? "Unknown";
        const amount = Number(group.Metrics?.UnblendedCost?.Amount ?? 0);
        const rounded = roundAmount(amount);

        if (rounded > 0) {
          totalsByService.set(serviceName, roundAmount((totalsByService.get(serviceName) ?? 0) + amount));
          total += amount;
        }
      }

      if (!groups.length && resultByTime.Total?.UnblendedCost?.Amount) {
        total += Number(resultByTime.Total.UnblendedCost.Amount);
      }
    }

    nextToken = response.NextPageToken;
  } while (nextToken);

  const services = Array.from(totalsByService.entries())
    .map(([service, amount]) => ({ amount, service }))
    .sort((a, b) => b.amount - a.amount);

  const value: AwsCostMonthToDate = {
    currency,
    fetchedAt: new Date().toISOString(),
    services,
    total: roundAmount(total)
  };

  costCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, value });

  return value;
}