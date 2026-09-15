export interface AdmissionLease {
  release(): void;
}

export type InferenceAdmission =
  | { readonly accepted: true; readonly lease: AdmissionLease }
  | {
      readonly accepted: false;
      readonly retryAfterSeconds: number;
    };

interface RateBucket {
  count: number;
  resetAt: number;
}

export class AgentConnectAdmissionController {
  private activeHttp = 0;
  private activeInference = 0;
  private readonly activeInferenceByGrant = new Map<string, number>();
  private readonly rateByGrant = new Map<string, RateBucket>();

  constructor(
    private readonly options: {
      readonly maxHttpRequests?: number;
      readonly maxInferenceRequests?: number;
      readonly maxInferenceRequestsPerGrant?: number;
      readonly maxRequestsPerGrantPerMinute?: number;
      readonly maxTrackedGrants?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  tryEnterHttp(): AdmissionLease | undefined {
    if (this.activeHttp >= (this.options.maxHttpRequests ?? 64)) {
      return undefined;
    }
    this.activeHttp += 1;
    return lease(() => {
      this.activeHttp -= 1;
    });
  }

  tryEnterInference(grantId: string): InferenceAdmission {
    const now = this.now();
    this.pruneRates(now);
    let bucket = this.rateByGrant.get(grantId);
    if (!bucket) {
      if (this.rateByGrant.size >= (this.options.maxTrackedGrants ?? 1024)) {
        return { accepted: false, retryAfterSeconds: 60 };
      }
      bucket = { count: 0, resetAt: now + 60_000 };
      this.rateByGrant.set(grantId, bucket);
    }
    if (bucket.count >= (this.options.maxRequestsPerGrantPerMinute ?? 60)) {
      return {
        accepted: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((bucket.resetAt - now) / 1000),
        ),
      };
    }
    bucket.count += 1;

    const activeForGrant = this.activeInferenceByGrant.get(grantId) ?? 0;
    if (
      this.activeInference >= (this.options.maxInferenceRequests ?? 4) ||
      activeForGrant >= (this.options.maxInferenceRequestsPerGrant ?? 2)
    ) {
      return { accepted: false, retryAfterSeconds: 1 };
    }

    this.activeInference += 1;
    this.activeInferenceByGrant.set(grantId, activeForGrant + 1);
    return {
      accepted: true,
      lease: lease(() => {
        this.activeInference -= 1;
        const remaining = (this.activeInferenceByGrant.get(grantId) ?? 1) - 1;
        if (remaining > 0) this.activeInferenceByGrant.set(grantId, remaining);
        else this.activeInferenceByGrant.delete(grantId);
      }),
    };
  }

  private pruneRates(now: number): void {
    for (const [grantId, bucket] of this.rateByGrant) {
      if (bucket.resetAt <= now && !this.activeInferenceByGrant.has(grantId)) {
        this.rateByGrant.delete(grantId);
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function lease(onRelease: () => void): AdmissionLease {
  let active = true;
  return {
    release() {
      if (!active) return;
      active = false;
      onRelease();
    },
  };
}
