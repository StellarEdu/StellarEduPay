# Software supply-chain security

StellarEduPay application images are published to GHCR by `.github/workflows/container-publish.yml`. The workflow runs on pushes to `main` and weekly, and publishes `backend` and `frontend` images tagged with the source commit SHA.

Each image build enables BuildKit SBOM and provenance generation. The workflow also publishes an attestation with GitHub's artifact-attestation service and creates a keyless Sigstore signature with Cosign. The signature is bound to the image digest, not a mutable tag.

## Deploying an image

1. Promote the exact `sha-<commit>` tag that was built by the publish workflow in the selected Kustomize overlay.
2. Use the GHCR image names shown in `deploy/k8s/overlays/mainnet/kustomization.yaml` and `deploy/k8s/overlays/testnet/kustomization.yaml`.
3. Do not deploy `latest`, `canary`, `placeholder`, or locally rebuilt images to a protected cluster.
4. Keep the tag promotion reviewable in Git. Kyverno will resolve the image to its digest and reject an image without a valid signature.

## Cluster enforcement

Install Kyverno before applying the application overlays. The base Kustomization includes `deploy/k8s/policies/verify-stellaredupay-images.yaml`, which uses `validationFailureAction: Enforce` and accepts only keyless signatures issued by GitHub Actions for the protected `main` branch container workflow. It also requires digest verification and mutates admitted tags to their signed digest.

The policy does not cover MongoDB or Redis images; those infrastructure images must be governed by the cluster's separate platform policy. Update the policy subject and GHCR owner together if the repository or publishing workflow is moved.

## Dependency installation

CI and Docker image builds use `npm ci --ignore-scripts` so package install hooks cannot execute implicitly. If a dependency genuinely requires a native build or generated artifact, add an explicit, reviewed follow-up step for that dependency rather than re-enabling all install scripts.

## Action and base-image pinning

GitHub Actions are referenced by full commit SHA with a release comment. Dockerfiles pin the Node base image to a manifest digest. Dependabot continues to track the GitHub Actions ecosystem and can propose reviewed SHA updates.
