FROM node:22-alpine
WORKDIR /app
COPY core.js server.js package.json ./
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
