import java.net.InetSocketAddress;
import java.util.concurrent.atomic.AtomicBoolean;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.handler.ContextHandler;
import org.eclipse.jetty.server.handler.ContextHandlerCollection;
import software.amazon.dynamodb.services.local.main.CommandLineInput;
import software.amazon.dynamodb.services.local.main.ServerRunner;
import software.amazon.dynamodb.services.local.monitoring.Telemetry;
import software.amazon.dynamodb.services.local.server.LocalDynamoDBRequestHandler;
import software.amazon.dynamodb.services.local.server.LocalDynamoDBServerHandler;

/**
 * Runs the downloaded DynamoDB Local handlers on IPv4 loopback only.
 * DynamoDB Local 3.3.1's standard launcher uses Server(port), which binds every
 * interface. This wrapper uses the same public handlers and an explicit address;
 * it requires no reflection, modified JARs, firewall rules, or extra runtime.
 * A Java 17+ JDK can launch this source directly with the downloaded classpath.
 */
public final class DynamoDBLocal {
  public static void main(String[] args) throws Exception {
    // Keep logging available until our database-close hook has completed.
    System.setProperty("log4j.shutdownHookEnabled", "false");
    var options = new CommandLineInput(args);
    if (!options.init()) return;
    if (options.shouldOptimizeDBBeforeStartup()) {
      throw new IllegalArgumentException("Database optimization is not supported by the loopback launcher.");
    }

    // Local development never needs telemetry, regardless of the supplied flags.
    Telemetry.configureTelemetry("MAVEN", ServerRunner.getSetupMode(options), false);
    var requests = new LocalDynamoDBRequestHandler(
        0, options.isInMemory(), options.getDbPath(), options.getSharedDb(),
        options.shouldDelayTransientStatuses());
    var handler = new LocalDynamoDBServerHandler(requests, options.getCorsParams());
    var context = new ContextHandler();
    context.setHandler(handler);
    var contexts = new ContextHandlerCollection();
    contexts.addHandler(context);
    var server = new Server(new InetSocketAddress("127.0.0.1", options.getPort()));
    server.setHandler(contexts);
    server.setStopTimeout(5_000);

    var closed = new AtomicBoolean();
    Runnable close = () -> {
      if (!closed.compareAndSet(false, true)) return;
      try {
        server.stop();
      } catch (Exception error) {
        System.err.println("DynamoDB Local shutdown failed: " + error.getMessage());
      } finally {
        // Flush and release the persistent SQLite database on SIGINT/SIGTERM.
        try {
          handler.close();
        } finally {
          org.apache.logging.log4j.LogManager.shutdown();
        }
      }
    };
    Runtime.getRuntime().addShutdownHook(new Thread(close, "dynamodb-local-shutdown"));
    try {
      server.start();
      System.out.println("DynamoDB Local listening on http://127.0.0.1:" + options.getPort());
      server.join();
    } finally {
      close.run();
    }
  }
}
