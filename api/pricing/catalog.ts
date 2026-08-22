// 料金カタログ — 生成物。手で編集しない。
//
//   cd api && npm run pricing:fetch
//
// spec: docs/superpowers/specs/2026-08-22-transfer-estimate-design.md
//
// これは **同梱の初期値でありフォールバック**であって、唯一の出所ではない。
// 通常は pricing.refresh ジョブが取得した値が pricing_cache (DB) に入り、
// そちらが使われる。ここが使われるのは、まだ一度も取得していないか、
// 外向きの通信が塞がれている環境。
//
// DEEP_ARCHIVE の storageTiers は代理値である (storageIsProxy: true)。
// AWS の料金 API に Deep Archive のストレージ単価が存在しないため、
// Intelligent-Tiering の Deep Archive Access 層の単価を使っている。

import type { PricingCatalog } from '../lib/pricing-types.js'

export const CATALOG: PricingCatalog = {
  "asOf": "2026-08-22",
  "awsPublishedAt": "2026-08-18T18:11:13Z",
  "aws": {
    "regions": {
      "ap-northeast-1": {
        "label": "Asia Pacific (Tokyo)",
        "storageClasses": {
          "STANDARD": {
            "label": "Standard",
            "storageTiers": [
              {
                "upToGb": 51200,
                "usd": 0.025
              },
              {
                "upToGb": 512000,
                "usd": 0.024
              },
              {
                "upToGb": null,
                "usd": 0.023
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.0047,
            "getPer1000": 0.00037,
            "retrievalPerGb": 0,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 0,
            "minBillableBytes": 0
          },
          "INTELLIGENT_TIERING": {
            "label": "Intelligent-Tiering",
            "storageTiers": [
              {
                "upToGb": 51200,
                "usd": 0.025
              },
              {
                "upToGb": 512000,
                "usd": 0.024
              },
              {
                "upToGb": null,
                "usd": 0.023
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.0047,
            "getPer1000": 0.00037,
            "retrievalPerGb": 0,
            "monitoringPerObjectMonth": 0.0000025,
            "minDurationDays": 0,
            "minBillableBytes": 0
          },
          "STANDARD_IA": {
            "label": "Standard-IA",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.0138
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.01,
            "getPer1000": 0.001,
            "retrievalPerGb": 0.01,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 30,
            "minBillableBytes": 131072
          },
          "ONEZONE_IA": {
            "label": "One Zone-IA",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.011
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.01,
            "getPer1000": 0.001,
            "retrievalPerGb": 0.01,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 30,
            "minBillableBytes": 131072
          },
          "GLACIER_IR": {
            "label": "Glacier Instant Retrieval",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.005
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.02,
            "getPer1000": 0.01,
            "retrievalPerGb": 0.03,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 90,
            "minBillableBytes": 131072
          },
          "GLACIER": {
            "label": "Glacier Flexible Retrieval",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.0045
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.03426,
            "getPer1000": 0.00037,
            "retrievalPerGb": 0.011,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 90,
            "minBillableBytes": 40960
          },
          "DEEP_ARCHIVE": {
            "label": "Glacier Deep Archive",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.002
              }
            ],
            "storageIsProxy": true,
            "putPer1000": 0.065,
            "getPer1000": 0.00037,
            "retrievalPerGb": 0.022,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 180,
            "minBillableBytes": 40960
          }
        },
        "egressTiers": [
          {
            "fromGb": 0,
            "upToGb": 10240,
            "usd": 0.114
          },
          {
            "fromGb": 10240,
            "upToGb": 51200,
            "usd": 0.089
          },
          {
            "fromGb": 51200,
            "upToGb": 153600,
            "usd": 0.086
          },
          {
            "fromGb": 153600,
            "upToGb": null,
            "usd": 0.084
          }
        ],
        "egressFreeGb": 100
      },
      "us-east-1": {
        "label": "US East (N. Virginia)",
        "storageClasses": {
          "STANDARD": {
            "label": "Standard",
            "storageTiers": [
              {
                "upToGb": 51200,
                "usd": 0.023
              },
              {
                "upToGb": 512000,
                "usd": 0.022
              },
              {
                "upToGb": null,
                "usd": 0.021
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.005,
            "getPer1000": 0.0004,
            "retrievalPerGb": 0,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 0,
            "minBillableBytes": 0
          },
          "INTELLIGENT_TIERING": {
            "label": "Intelligent-Tiering",
            "storageTiers": [
              {
                "upToGb": 51200,
                "usd": 0.023
              },
              {
                "upToGb": 512000,
                "usd": 0.022
              },
              {
                "upToGb": null,
                "usd": 0.021
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.005,
            "getPer1000": 0.0004,
            "retrievalPerGb": 0,
            "monitoringPerObjectMonth": 0.0000025,
            "minDurationDays": 0,
            "minBillableBytes": 0
          },
          "STANDARD_IA": {
            "label": "Standard-IA",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.0125
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.01,
            "getPer1000": 0.001,
            "retrievalPerGb": 0.01,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 30,
            "minBillableBytes": 131072
          },
          "ONEZONE_IA": {
            "label": "One Zone-IA",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.01
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.01,
            "getPer1000": 0.001,
            "retrievalPerGb": 0.01,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 30,
            "minBillableBytes": 131072
          },
          "GLACIER_IR": {
            "label": "Glacier Instant Retrieval",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.004
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.02,
            "getPer1000": 0.01,
            "retrievalPerGb": 0.03,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 90,
            "minBillableBytes": 131072
          },
          "GLACIER": {
            "label": "Glacier Flexible Retrieval",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.0036
              }
            ],
            "storageIsProxy": false,
            "putPer1000": 0.03,
            "getPer1000": 0.0004,
            "retrievalPerGb": 0.01,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 90,
            "minBillableBytes": 40960
          },
          "DEEP_ARCHIVE": {
            "label": "Glacier Deep Archive",
            "storageTiers": [
              {
                "upToGb": null,
                "usd": 0.00099
              }
            ],
            "storageIsProxy": true,
            "putPer1000": 0.05,
            "getPer1000": 0.0004,
            "retrievalPerGb": 0.02,
            "monitoringPerObjectMonth": 0,
            "minDurationDays": 180,
            "minBillableBytes": 40960
          }
        },
        "egressTiers": [
          {
            "fromGb": 0,
            "upToGb": 10240,
            "usd": 0.09
          },
          {
            "fromGb": 10240,
            "upToGb": 51200,
            "usd": 0.085
          },
          {
            "fromGb": 51200,
            "upToGb": 153600,
            "usd": 0.07
          },
          {
            "fromGb": 153600,
            "upToGb": null,
            "usd": 0.05
          }
        ],
        "egressFreeGb": 100
      }
    }
  },
  "wasabi": {
    "label": "Wasabi Hot Cloud Storage",
    "perTbMonthUsd": 7.99,
    "minDurationDays": 90,
    "minBillableTb": 1
  }
}
