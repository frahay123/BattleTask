# Use the official Node.js image
FROM node:20

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your app's source code
COPY . .

# Expose the port Cloud Run will use
EXPOSE 8080

# Start the server
CMD [ "node", "backend.js" ]