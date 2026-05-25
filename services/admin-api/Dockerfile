FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs auth.mjs ics.mjs caldav.mjs ./
EXPOSE 6091
CMD ["node", "server.mjs"]
