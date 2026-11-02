/**
 * O workflow do fork publica as três imagens que a VPS puxa, em amd64 e
 * arm64 nativos, com o SHA do commit e `latest` na main. Não é o
 * publish-image.yml do upstream: aquele continua gated em
 * `repository_owner == melgarafael`.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const YML = readFileSync(".github/workflows/publicar-imagens-do-fork.yml", "utf8");

describe("publicar imagens do fork", () => {
  it("dispara no push da main e no dispatch", () => {
    expect(YML).toMatch(/push:\n\s+branches: \[main\]/);
    expect(YML).toContain("workflow_dispatch:");
  });

  it("só roda neste repositório, em runner nativo, sem a máquina própria", () => {
    expect(YML).toContain("if: github.repository == 'thdokra/DigifastCRM'");
    expect(YML).toContain("runs-on: ubuntu-latest");
    expect(YML).toContain("ubuntu-24.04-arm");
    expect(YML).not.toContain("deskcomm-proprio");
    expect(YML).not.toContain("qemu");
  });

  it("publica app, worker e scheduler nas duas archs, com SHA e latest na main", () => {
    expect(YML).toContain("dockerfile: Dockerfile");
    expect(YML).toContain("dockerfile: Dockerfile.worker");
    expect(YML).toContain("dockerfile: Dockerfile.scheduler");
    expect(YML).not.toContain("Dockerfile.voice-agent");
    expect(YML).toContain("arch: [amd64, arm64]");
    expect(YML).toContain("platforms: ${{ matrix.arch == 'arm64' && 'linux/arm64' || 'linux/amd64' }}");
    expect(YML).toContain('lista="${img}:${SHA}-${ARCH}"');
    expect(YML).toContain('refs/heads/main');
    expect(YML).toContain("${img}:latest-${ARCH}");
    expect(YML).toContain("APP_VERSION=${{ github.sha }}");
    expect(YML).toContain("docker buildx imagetools create");
    expect(YML).toContain('"${tag}-amd64"');
    expect(YML).toContain('"${tag}-arm64"');
    expect(YML).toContain('manifesto_tem_plataforma "$tag" linux/amd64');
    expect(YML).toContain('manifesto_tem_plataforma "$tag" linux/arm64');
  });

  it("o nome da imagem deriva do dono do repositório", () => {
    expect(YML).toContain("${REGISTRY}/${GITHUB_REPOSITORY_OWNER}/${NOME}");
  });
});
