## Deploy to Cloud Run

```
gcloud beta run services replace gcp-service.yaml
gcloud run services set-iam-policy k6-runner gcp-policy.yaml --region=asia-northeast1
```
