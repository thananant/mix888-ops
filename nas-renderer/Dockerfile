# Mix888 NAS bill renderer
# Base image already contains Chromium + all Playwright deps for v1.49.0
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# Thai + CJK fonts: Chinese shop/product names must not render as tofu boxes
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-thai-tlwg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# nas-worker.js + bill-render.html (+ any assets it references)
COPY . .

ENV NODE_ENV=production

CMD ["node", "nas-worker.js"]
