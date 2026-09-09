FROM node:22-alpine
RUN apk add --no-cache git bash docker-cli
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
