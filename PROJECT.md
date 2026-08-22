# PROJECT.md — TencentDB Agent Memory

> File định hướng tối ưu token cho AI Agent. Đọc mục cần thiết thay vì toàn bộ README (chi tiết đầy đủ nằm ở README.md / INSTALL.md / ROADMAP.md — chỉ mở khi cần).

## 1. Tổng quan

**TencentDB Agent Memory** — nền tảng team-memory mã nguồn mở (MIT, TencentCloud) giúp AI Agent liên đội "nhớ" và tái sử dụng kinh nghiệm: cuộc hội thoại, kỹ năng (Skill), tài liệu (Wiki), mã nguồn (CodeGraph) đều biến thành **Memory Asset** có quyền sở hữu/phiên bản/phân quyền, được **bind** cho từng Agent theo nhu cầu.

Slogan: *Agents remember. Humans innovate.* — Mục tiêu cốt lõi: agent mới không phải "học lại từ đầu" (cold start), và kinh nghiệm team được tích lũy vĩnh viễn.

Bản release hiện tại: **v2.0.1-beta.x**. Đây là repo phát triển, tiếng Anh + tiếng Trung (README_CN/INSTALL_CN), không có README tiếng Việt.

## 2. Mục tiêu dự án

- **Giảm việc lặp lại**: ngữ cảnh dự án, tài liệu, workflow đã học được lưu lại và tái dùng, không phải giải thích lại mỗi phiên.
- **4 loại Memory Asset**: Chat Memory (nhớ người/ngữ cảnh), Skill (kinh nghiệm thực thi, có version/resource/trigger), Wiki (trang tài liệu + link graph), CodeGraph (symbol + quan hệ gọi hàm + impact path).
- **Phân quyền rõ ràng**: visibility `private / team / restricted(ACL) / agent`; role 2 tầng: System Admin (quản lý user/team) và Team-level (Admin/Member); mỗi asset có Owner.
- **Tích hợp zero-code**: Agent trỏ `baseURL` sang Proxy là xong — không cần plugin/hook/MCP. Hỗ trợ: Claude Code, Codex, CodeBuddy, DeepSeek Harness, WorkBuddy, Hermes, OpenClaw.
- **Truy xuất đúng, không tràn context**: BM25 + vector + RRF, có giới hạn số item / ngân sách ký tự / timeout.
- Các mục đang phát triển: xem ROADMAP.md (Agent template, task `mem:` commands, editable memory L1-L3, L0/L1 search, Cursor adapter).

## 3. Kiến trúc hệ thống

Monorepo **không có package.json root** — 4 package độc lập, tự cài/test:

```
AgentMemory/
├── MemoryCore/     # Plugin OpenClaw "memory-core" — engine bộ nhớ phân lớp
├── MemoryKnowledge/# "memory-hub kiến thức" — dịch vụ Wiki + CodeGraph độc lập
├── MemoryPanel/    # "memory-hub" — panel quản trị web Team/User/Agent/Asset (backend + web/)
├── MemoryProxy/    # "proxy" — forward request LLM, inject memory, log/telemetry
├── sdk/            # SDK memory-core: Python + TypeScript (kèm AGENT_GUIDE)
└── deploy/         # docker images, global-images (start-all.sh, .env.example) — ports chuẩn
```

### Luồng hoạt động chính

1. **Agent → MemoryProxy** (thay base URL): Proxy inject memory/skill/knowledge theo identity (Fixed Binding + ACL), forward tới LLM thật.
2. **MemoryProxy → MemoryCore**: lưu conversation, gọi pipeline trích xuất async; lệnh `mem:sync` / `mem:create-skill` / `mem:help` xử lý tại chỗ.
3. **MemoryCore pipeline phân lớp** (async): `L0 Conversation → L1 Atom → L2 Scenario → L3 Persona`. Bình thường L2/L3 bootstrap ngữ cảnh nhanh; khi cần fact cụ thể thì BM25+vector+RRF đào xuống L1/L0.
4. **MemoryKnowledge**: import codebase → CodeGraph (file/symbol/call graph/impact path); import docs → Wiki (trang + link graph). Agent khám phá qua `/v3/tools/list` rồi gọi `/v3/tools/call` theo nhu cầu (on-demand, không inject cả khối).
5. **MemoryPanel**: giao diện web quản lý mọi thứ — được người + agent dùng để tạo team, review asset, bind asset cho agent.

### Các khái niệm bắt buộc nhớ

| Khái niệm | Ý nghĩa |
|---|---|
| L0/L1/L2/L3 | 4 tầng đúc kết hội thoại (thô → sự kiện → kịch bản → persona) |
| 4 Asset type | Chat Memory, Skill, Wiki, CodeGraph — đăng ký thống nhất |
| Visibility | private / team / restricted / agent |
| Loadout | Tập asset + mức ưu tiên được bind cho một agent |
| Memory Hub | Tên chung panel quản trị (MemoryPanel) |

## 4. Tech stack

| Service | Runtime | Framework | DB/Storage | Khác |
|---|---|---|---|---|
| MemoryCore | Node ≥22, TS (ESM) | plugin OpenClaw, Vercel AI SDK v6 | SQLite-vec (vector), BM25 local, TCP TencentCloud VectorDB, Mongo/ClickHouse/Redis (optional) | useLLM local/remote, js-tiktoken, OpenTelemetry+Opik, zod 4, vitest |
| MemoryKnowledge | Node ≥22, TS | Hono, drizzle-orm, MCP SDK | better-sqlite3 | graphology (graph), MiniSearch, Langfuse/ClickHouse telemetry, simple-git clone repo |
| MemoryPanel | Node ≥22, TS | Hono (backend), React (web/) | (state trong hub) | i18n en-US/zh-CN, Tea component (design Tencent), Vite, zod 3, ULID, vitest |
| MemoryProxy | TSx | Hono | SQLite/Redis session, ClickHouse log, Langfuse/Opik tracing | agent adapters riêng từng nền tảng, rate-limit, credit reporter |

Tất cả code TS ESM, Node ≥22. Build: `tsdown` (Core, Knowledge) / `tsc` (Panel); dev bằng `tsx`. **Core/Proxy/Knowledge chưa có unit test committed** (chỉ có vitest config + script); test thực tế nằm ở MemoryPanel (`tests/`) và các script e2e/smoke (xem bản đồ mục 5). Không dùng workspace/pnpm root.

## 5. Bản đồ tìm kiếm dữ liệu (dành cho AI Agent)

Khi agent cần tìm gì, tra đúng chỗ — tiết kiệm lượt grep/toàn bộ repo:

| Cần tìm | Nơi tra |
|---|---|
| API routes panel | `MemoryPanel/src/panel/http/routes/` (agent-*, chat-memory, skill, task, knowledge/, llm-config/, meta) |
| Frontend React | `MemoryPanel/web/src/` (pages/, components/, lib/api/, lib/teamApi.ts, stores/) |
| Pipeline bộ nhớ L0–L3 | `MemoryCore/src/core/` (conversation/, persona/, profile/, scene/, store/, skill/ + prompts/) |
| Vector/BM25 search | `MemoryCore/src/core/store/` (sqlite.ts, bm25-*.ts, tcvdb-*.ts, embedding.ts, search-utils.ts) |
| Wiki + CodeGraph engine | `MemoryKnowledge/src/` (routes/wiki.ts, routes/code-graph.ts, engines/, db/schema.ts) |
| Proxy: adapter từng agent | `MemoryProxy/src/` — handlers riêng: anthropicHandler, codexHandler, workbuddyHandler, agent-adapters/, guard-adapter.ts |
| Memory injection (proxy) | `MemoryProxy/src/injection/`, `MemoryProxy/src/memory/`, `MemoryProxy/src/session/` |
| API contract | `MemoryKnowledge/openapi.yaml`, MemoryPanel generate: `npm run generate:meta-openapi` |
| Test & e2e | Unit: `MemoryPanel/tests/`; e2e/smoke: `MemoryCore/scripts/e2e-*.ts` + `scripts/smoke-skill/`, `MemoryPanel/scripts/e2e-*-authz.sh`, `MemoryKnowledge/docker/smoke-test.sh`, `MemoryProxy/scripts/qa/` |
| Deploy/docker/ports | `deploy/global-images/` (start-all.sh, .env.example) |

**Ports mặc định**: MemoryCore 8420, Panel 8125. Config trong `deploy/global-images/.env.example`.

## 6. Notes & quy ước cho quyết định

- **Nhánh hiện tại là `full`** (main tham chiếu cho PR: `feat/server_team`). WIP chưa commit: routes `llm-config` mới trong MemoryPanel (backend + `web/src/components/llm-settings/`, `lib/api/llm-config.ts`, tests/llm-config.test.ts).
- Sửa MemoryPanel phải đồng bộ cả 2 nơi: backend route + frontend component + i18n (en-US/zh-CN) + teamApi.
- **Không sửa hành vi trích xuất nhớ nhẹ tay**: pipeline L0–L3 là async worker (MemoryCore/src/services/pipeline-worker.ts); thay đổi prompt ở `core/prompts/`, không hardcode trong luồng.
- CodeGraph ưu tiên repo HTTPS công khai; repo private/SSH vẫn đang hoàn thiện (ghi chú từ README — xác minh lại ở code trước khi dựa vào).
- Wiki/CodeGraph build async → asset có trạng thái `processing → ready`, cần chờ.
- Đóng góp: đọc CONTRIBUTING.md; kiểm tra chuẩn: `npm run typecheck` (+ `npm test` nếu package có test) trong package đã sửa; commit imperative, <72 ký tự.
- Tài liệu tham chiếu khi cần chi tiết: `INSTALL.md` (tích hợp từng agent), `ROADMAP.md` (việc tiếp theo), `CHANGELOG.md`.