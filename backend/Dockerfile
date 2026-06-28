FROM node:20-alpine

# better-sqlite3 needs Python + build tools to compile its native addon
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY src/ ./src/

EXPOSE 3001

CMD ["node", "src/index.js"]
