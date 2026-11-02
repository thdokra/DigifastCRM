/**
 * O workflow do fork publica as três imagens que a VPS puxa, só em amd64,
 * com o SHA do commit e `latest` na main. Não é o publish-image.yml do
 * upstream: aquele continua gated em `repository_owner == melgarafael`.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const YML = readFileSync(".github/workflows/publicar-imagens-do-fork.yml", "utf8");

describe("publicar imagens do fork", () => {
  it("dispara no push da main e no dispatch", () => {
    expect(YML).toMatch(/push:\n\s+branches: \[main\]/);
    expect(YML).toContain("workflow_dispatch:");
  });

  it("só roda neste repositório e só em runner do GitHub", () => {
    expect(YML).toContain("if: github.repository == 'thdokra/DigifastCRM'");
    expect(YML).toContain("runs-on: ubuntu-latest");
    expect(YML).not.toContain("deskcomm-proprio");
  });

  it("publica app, worker e scheduler em linux/amd64, com SHA e latest na main", () => {
    expect(YML).toContain("dockerfile: Dockerfile");
    expect(YML).toContain("dockerfile: Dockerfile.worker");
    expect(YML).toContain("dockerfile: Dockerfile.scheduler");
    expect(YML).not.toContain("Dockerfile.voice-agent");
    expect(YML).toContain("platforms: linux/amd64");
    expect(YML).toContain('lista="${img}:${SHA}"');
    expect(YML).toContain('refs/heads/main');
    expect(YML).toContain("${img}:latest");
    expect(YML).toContain("APP_VERSION=${{ github.sha }}");
  });

  it("o nome da imagem deriva do dono do repositório", () => {
    expect(YML).toContain("${REGISTRY}/${GITHUB_REPOSITORY_OWNER}/${NOME}");
  });
});
