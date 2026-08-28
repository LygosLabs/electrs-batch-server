FROM --platform=linux/amd64 node:14-alpine

WORKDIR /usr/src/electrs-batch-server

COPY package*.json .

RUN npm install

COPY . .

CMD ["npm", "start"]
