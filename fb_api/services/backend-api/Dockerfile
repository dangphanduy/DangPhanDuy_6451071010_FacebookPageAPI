FROM node:18-alpine

# Cài đặt python và build-base đề phòng sqlite3 cần build từ source (nếu không có prebuilt)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Tạo thư mục data để mount volume SQLite
RUN mkdir -p data

EXPOSE 3004

CMD ["node", "server.js"]
