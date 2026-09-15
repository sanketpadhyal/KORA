FROM node:22-alpine

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

ENV NODE_ENV=production
ENV KORA_DATA_DIR=/data

EXPOSE 8080

CMD ["npm", "run", "start"]
