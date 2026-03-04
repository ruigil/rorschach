import figlet from 'figlet';
import index from './index.html'; 

const server = Bun.serve({
  port: 3000,
  routes: {
    "/": index, 
    "/figlet": () => {
      const body = figlet.textSync('Bun!');
      return new Response(body);
    }
  }
});

console.log(`Listening on ${server.url}`);
