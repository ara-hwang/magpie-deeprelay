# magpie-deeprelay

[magpie](https://usemagpie.ai/) / [OpenCode](https://opencode.ai/) 프로바이더 플러그인입니다. [deeprelay.ai](https://deeprelay.ai/)의 OpenAI 호환 추론 API를 magpie 모델로 연결하고, deeprelay 구독의 사용량을 magpie의 quota 화면과 CLI에 표시합니다.

## 연결하는 것

- 엔드포인트: `https://api.deeprelay.ai/v1`
- 인증: deeprelay API 키 (`Authorization: Bearer deeprelay_live_…`)
- API 형식: OpenAI Chat Completions (`@ai-sdk/openai-compatible`)
- 모델 목록: `GET /v1/models?modality=chat`을 계정별로 조회
- 사용량: `GET /v1/billing/subscription`, 필요할 때 `GET /v1/billing/balance`

deeprelay 키에 `billing:read` 스코프가 없으면 사용량만 표시되지 않고, 추론은 그대로 동작합니다. 기본 대시보드 키(standard)에는 이 스코프가 포함됩니다.

## 표시하는 사용량

`magpie quota deeprelay`와 magpie의 Providers 화면에 다음이 표시됩니다.

| 항목 | 내용 |
| --- | --- |
| Monthly input / output | 이번 결제 기간의 가중 입력·출력 토큰 사용량 (한도 대비 %) |
| Weekly input / output (rolling) | 최근 7일 롤링 가중 토큰 한도. 리셋 시각 없음 |
| Metered usage | 플랜이 커버한 트래픽의 정가 환산액과 기간별 상한 |
| Web searches | 이번 기간의 서버 검색 사용량 / 플랜 한도 |
| Pay-as-you-go | 최근 24시간 동안 잔액으로 청구된 호출 수 |
| 잔액 | deeprelay 크레딧 잔액 (PAYG가 발생했거나 구독이 없을 때) |

## 설치

### magpie에 로컬 폴더로 추가

```sh
git clone https://github.com/ara-hwang/magpie-deeprelay.git
magpie plugin add ./magpie-deeprelay
magpie plugin login deeprelay
```

`magpie plugin add`는 폴더를 복사하지 않고 그 자리에서 로드합니다. 폴더를 옮기면 다시 추가해야 합니다.

### 비공개 저장소에서 설치

이 저장소는 비공개입니다. `magpie plugin add github:ara-hwang/magpie-deeprelay`는 GitHub 인증이 없는 Bun 환경에서 실패할 수 있으므로, 위처럼 clone한 뒤 경로로 추가하는 방식을 권장합니다.

### OpenCode

패키지는 OpenCode의 provider plugin 형식을 따릅니다. npm에 게시한 뒤 `opencode.json`에 추가할 수 있습니다.

```json
{
  "plugin": ["opencode-deeprelay-auth"]
}
```

## 사용

```sh
magpie models deeprelay          # 이 계정이 쓸 수 있는 모델
magpie quota deeprelay           # 사용량과 잔액
magpie quota deeprelay --json    # 스크립트용
magpie provider test deeprelay   # 요청 경로 확인
```

에이전트에는 `deeprelay/deepseek-v4.1-flash`처럼 지정합니다.

```sh
magpie claude deeprelay/deepseek-v4.1-flash
magpie codex deeprelay/glm-5.3
```

## 환경 변수

| 변수 | 설명 |
| --- | --- |
| `DEEPRELAY_API_BASE` | API 기본 URL을 바꿉니다. 기본값 `https://api.deeprelay.ai/v1`. 테스트나 프록시용입니다. |
| `DEEPRELAY_API_KEY` | 이 플러그인은 읽지 않습니다. magpie에 로그인한 계정 키를 사용합니다. |

플러그인 코드는 두 번째 인자의 `options.baseURL`도 받지만, provider 플러그인의 options 노출은 magpie 버전에 따라 다릅니다. 확실하게 바꾸려면 `DEEPRELAY_API_BASE`를 사용하세요.

## 테스트

```sh
node --test
node scripts/fake-server.mjs   # 다른 터미널에서 실행
```

`test/plugin.test.mjs`는 다음을 검증합니다.

- 프로바이더 선언과 모델 시드
- 계정별 모델 목록과 실패 시 기존 목록 유지
- 구독 사용량 → quota window 매핑 (월간·주간·비용 상한·검색)
- PAYG 호출 시 잔액 조회
- 미구독 상태의 잔액 표시
- `billing:read` 스코프 부족과 401 처리
- 모든 요청에 API 키를 서명하는 loader
- `DEEPRELAY_API_BASE` 오버라이드

`scripts/fake-server.mjs`는 실제 magpie에 설치해 `magpie plugin login`, `magpie quota`, `magpie provider test`를 검증할 때 쓰는 가짜 deeprelay API입니다.

## 보안

- API 키는 magpie의 `plugin-auth.json`(모드 600)에 저장되며, 이 플러그인은 키를 로그나 파일에 쓰지 않습니다.
- 사용량 조회는 키가 허용하는 `billing:read` 범위의 읽기 요청만 보냅니다.
- 모델 요청은 deeprelay의 `api.deeprelay.ai`로만 전달됩니다. `DEEPRELAY_API_BASE`를 바꾸면 그 주소로 전달됩니다.

## 라이선스

MIT
