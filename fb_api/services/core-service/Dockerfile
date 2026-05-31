FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Tạo thư mục data nếu chưa có
RUN mkdir -p data && \
    echo '{"users":{}}' > data/blacklist.json && \
    echo '[]' > data/review_queue.json

CMD ["node", "server.js"]
