# CHESS MIND (정적 버전)

빌드 과정 없이 그대로 배포되는 순수 HTML/CSS/JS 버전입니다.

```
index.html   화면 구조
style.css    스타일
script.js    chess.js(인라인) + 엔진 래퍼 + 분석/등급/피드백 + UI
stockfish/   Stockfish 16 WASM js + wasm — 반드시 함께 배포 (파일 2개)
vercel.json                캐시 헤더
```

## Vercel 배포
1. 이 폴더를 GitHub에 올리고 Vercel에서 Import (Framework: Other, Build Command/Output 비워 둠)
   또는 `npx vercel --prod` 를 이 폴더에서 실행.
2. 환경변수 없음. 외부 API 없음.

## 로컬 실행
`file://` 로는 ES module / Worker 가 동작하지 않으므로 서버가 필요합니다: `python3 -m http.server 3000`
